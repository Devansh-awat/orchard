import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';

export type SeriesPoint = { x: number; y: number };

export type HttpMetricsSeries = {
  requestRate: SeriesPoint[];
  errorRate: SeriesPoint[];
  latencyP50: SeriesPoint[];
  latencyP95: SeriesPoint[];
};

export type LogEntry = {
  timestamp?: string;
  level?: string;
  message: string;
  raw: string;
  metadata?: Record<string, any>;
};

export type DetectedRuntime = {
  language: string;
  framework: string | null;
  version: string | null;
  confidence: 'high' | 'medium' | 'low';
  detectedFrom: 'build_logs' | 'image' | 'env_vars' | 'dockerfile';
};

export type ErrorGroup = {
  fingerprint: string;
  type: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: Array<{
    timestamp?: string;
    message: string;
    stackTrace?: string;
  }>;
  trend: 'rising' | 'stable' | 'falling';
};

export type Capabilities = {
  logs: boolean;
  containerMetrics: boolean;
  httpMetrics: boolean;
  customMetrics: boolean;
  traces: boolean;
  runtime: DetectedRuntime | null;
};

export type DeploymentOverview = {
  uptime: string;
  podCount: number;
  restarts: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  httpRequestRate: number | null;
  httpErrorRate: number | null;
  httpP95Latency: number | null;
};

@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);
  private readonly vmBase =
    process.env.VICTORIAMETRICS_URL ??
    'http://victoriametrics.orchard-metrics.svc.cluster.local:8428';

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sWorkload: K8sWorkloadService,
  ) {}

  async getCapabilities(deploymentId: string): Promise<Capabilities> {
    const [ingressCount, runtime] = await Promise.all([
      this.prisma.ingress.count({ where: { deploymentId } }),
      this.detectRuntime(deploymentId).catch(() => null),
    ]);

    return {
      logs: true,
      containerMetrics: true,
      httpMetrics: ingressCount > 0,
      customMetrics: false,
      traces: false,
      runtime,
    };
  }

  async getHttpMetrics(
    deploymentId: string,
    startMs: number,
    endMs: number,
    stepMs: number,
  ): Promise<HttpMetricsSeries> {
    const serviceSelector = await this.buildTraefikServiceSelector(deploymentId);
    if (!serviceSelector) {
      return { requestRate: [], errorRate: [], latencyP50: [], latencyP95: [] };
    }

    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const stepSec = Math.max(1, Math.round(stepMs / 1000));
    const rateWin = Math.max(60, stepSec * 2);

    const queries = {
      requestRate: `sum(rate(traefik_service_requests_total{service=~"${serviceSelector}"}[${rateWin}s]))`,
      errorRate: `sum(rate(traefik_service_requests_total{service=~"${serviceSelector}",code=~"5.."}[${rateWin}s]))`,
      latencyP50: `histogram_quantile(0.50, sum(rate(traefik_service_request_duration_seconds_bucket{service=~"${serviceSelector}"}[${rateWin}s])) by (le)) * 1000`,
      latencyP95: `histogram_quantile(0.95, sum(rate(traefik_service_request_duration_seconds_bucket{service=~"${serviceSelector}"}[${rateWin}s])) by (le)) * 1000`,
    };

    const [requestRate, errorRate, latencyP50, latencyP95] = await Promise.all([
      this.queryRange(queries.requestRate, startSec, endSec, stepSec),
      this.queryRange(queries.errorRate, startSec, endSec, stepSec),
      this.queryRange(queries.latencyP50, startSec, endSec, stepSec),
      this.queryRange(queries.latencyP95, startSec, endSec, stepSec),
    ]);

    return { requestRate, errorRate, latencyP50, latencyP95 };
  }

  async getStructuredLogs(
    deploymentId: string,
    tailLines: number = 200,
    level?: string,
    search?: string,
  ): Promise<{ entries: LogEntry[] }> {
    const deployment = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: { name: true, namespace: true },
    });

    const pods = await this.prisma.pod.findMany({
      where: { deploymentId },
      select: { name: true },
    });

    const allEntries: LogEntry[] = [];

    for (const pod of pods) {
      try {
        const result = await this.k8sWorkload.getPodLogs(
          pod.name,
          deployment.namespace,
          undefined,
          tailLines,
        );
        const lines = (result.logs || '').split('\n').filter(Boolean);
        for (const line of lines) {
          allEntries.push(parseLine(line));
        }
      } catch (err) {
        this.logger.warn(`failed to fetch logs for pod ${pod.name}: ${(err as Error).message}`);
      }
    }

    let filtered = allEntries;

    if (level) {
      const upper = level.toUpperCase();
      filtered = filtered.filter((e) => e.level?.toUpperCase() === upper);
    }

    if (search) {
      const lower = search.toLowerCase();
      filtered = filtered.filter((e) => e.raw.toLowerCase().includes(lower));
    }

    return { entries: filtered };
  }

  async getOverview(deploymentId: string): Promise<DeploymentOverview> {
    const deployment = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: {
        name: true,
        namespace: true,
        createdAt: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true,
        replicas: true,
      },
    });

    const pods = await this.prisma.pod.findMany({
      where: { deploymentId },
      select: { restartCount: true, status: true },
    });

    const activePods = pods.filter((p) => p.status !== 'Succeeded' && p.status !== 'Failed');
    const restarts = pods.reduce((sum, p) => sum + p.restartCount, 0);

    const ns = escapeLabel(deployment.namespace);
    const podRe = `${escapeRegex(deployment.name)}-.*`;

    const [cpuMilli, memBytes] = await Promise.all([
      this.queryInstant(
        `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod=~"${podRe}",container="",image=""}[60s])) * 1000`,
      ),
      this.queryInstant(
        `sum(container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRe}",container="",image=""})`,
      ),
    ]);

    const totalCpuRequest = (deployment.cpuRequestMilli ?? 0) * (deployment.replicas ?? 1);
    const totalMemRequest =
      (deployment.memoryRequestBytes ? Number(deployment.memoryRequestBytes) : 0) *
      (deployment.replicas ?? 1);

    const cpuPercent =
      totalCpuRequest > 0 && cpuMilli !== null ? (cpuMilli / totalCpuRequest) * 100 : null;
    const memoryPercent =
      totalMemRequest > 0 && memBytes !== null ? (memBytes / totalMemRequest) * 100 : null;

    let httpRequestRate: number | null = null;
    let httpErrorRate: number | null = null;
    let httpP95Latency: number | null = null;

    const serviceSelector = await this.buildTraefikServiceSelector(deploymentId);
    if (serviceSelector) {
      const rateWin = 60;

      [httpRequestRate, httpErrorRate, httpP95Latency] = await Promise.all([
        this.queryInstant(
          `sum(rate(traefik_service_requests_total{service=~"${serviceSelector}"}[${rateWin}s]))`,
        ),
        this.queryInstant(
          `sum(rate(traefik_service_requests_total{service=~"${serviceSelector}",code=~"5.."}[${rateWin}s]))`,
        ),
        this.queryInstant(
          `histogram_quantile(0.95, sum(rate(traefik_service_request_duration_seconds_bucket{service=~"${serviceSelector}"}[${rateWin}s])) by (le)) * 1000`,
        ),
      ]);
    }

    return {
      uptime: deployment.createdAt.toISOString(),
      podCount: activePods.length,
      restarts,
      cpuPercent,
      memoryPercent,
      httpRequestRate,
      httpErrorRate,
      httpP95Latency,
    };
  }

  async detectRuntime(deploymentId: string): Promise<DetectedRuntime> {
    const deployment = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: {
        buildType: true,
        buildLogs: true,
        image: true,
        dockerfilePath: true,
        envVars: { select: { key: true, value: true } },
      },
    });

    const fromBuildLogs = detectFromBuildLogs(deployment.buildLogs);
    if (fromBuildLogs) return fromBuildLogs;

    const fromEnv = detectFromEnvVars(deployment.envVars);
    if (fromEnv) return fromEnv;

    const fromImage = detectFromImage(deployment.image);
    if (fromImage) return fromImage;

    const fromDockerfile = detectFromDockerfilePath(deployment.dockerfilePath);
    if (fromDockerfile) return fromDockerfile;

    return {
      language: 'unknown',
      framework: null,
      version: null,
      confidence: 'low',
      detectedFrom: 'build_logs',
    };
  }

  async getErrors(
    deploymentId: string,
    timeWindowMinutes: number = 60,
  ): Promise<{ errors: ErrorGroup[] }> {
    const tailLines = Math.min(5000, timeWindowMinutes * 50);
    const { entries } = await this.getStructuredLogs(deploymentId, tailLines);

    const cutoff = new Date(Date.now() - timeWindowMinutes * 60 * 1000);
    const windowEntries = entries.filter((e) => {
      if (!e.timestamp) return true;
      try {
        return new Date(e.timestamp) >= cutoff;
      } catch {
        return true;
      }
    });

    const errorEntries: Array<{
      timestamp?: string;
      type: string;
      message: string;
      stackTrace?: string;
    }> = [];

    for (let i = 0; i < windowEntries.length; i++) {
      const entry = windowEntries[i];
      const isError =
        entry.level === 'ERROR' ||
        entry.level === 'FATAL' ||
        hasStackTraceStart(entry.raw);

      if (!isError) continue;

      const { type, message: errMsg } = extractErrorInfo(entry.message || entry.raw);

      let stackTrace: string | undefined;
      const stackLines: string[] = [];
      let j = i + 1;
      while (j < windowEntries.length && isStackFrame(windowEntries[j].raw)) {
        stackLines.push(windowEntries[j].raw);
        j++;
      }
      if (stackLines.length > 0) {
        stackTrace = stackLines.join('\n');
      }

      errorEntries.push({
        timestamp: entry.timestamp,
        type,
        message: errMsg,
        stackTrace,
      });
    }

    const groups = new Map<
      string,
      {
        type: string;
        message: string;
        entries: Array<{ timestamp?: string; message: string; stackTrace?: string }>;
      }
    >();

    for (const err of errorEntries) {
      const normalized = normalizeErrorMessage(err.message);
      const fp = createHash('sha256')
        .update(`${err.type}:${normalized}`)
        .digest('hex')
        .slice(0, 16);

      let group = groups.get(fp);
      if (!group) {
        group = { type: err.type, message: err.message, entries: [] };
        groups.set(fp, group);
      }
      group.entries.push({
        timestamp: err.timestamp,
        message: err.message,
        stackTrace: err.stackTrace,
      });
    }

    const errors: ErrorGroup[] = [];

    for (const [fingerprint, group] of groups) {
      const sorted = group.entries.sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0;
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });

      const firstSeen = sorted[0]?.timestamp ?? new Date().toISOString();
      const lastSeen = sorted[sorted.length - 1]?.timestamp ?? new Date().toISOString();
      const samples = sorted.slice(-3);

      const mid = Math.floor(sorted.length / 2);
      const firstHalf = mid > 0 ? mid : sorted.length;
      const secondHalf = sorted.length - firstHalf;
      let trend: 'rising' | 'stable' | 'falling' = 'stable';
      if (firstHalf > 0 && secondHalf > 0) {
        const ratio = secondHalf / firstHalf;
        if (ratio > 1.3) trend = 'rising';
        else if (ratio < 0.7) trend = 'falling';
      }

      errors.push({
        fingerprint,
        type: group.type,
        message: group.message,
        count: sorted.length,
        firstSeen,
        lastSeen,
        samples,
        trend,
      });
    }

    errors.sort((a, b) => b.count - a.count);

    return { errors };
  }

  private async buildTraefikServiceSelector(deploymentId: string): Promise<string | null> {
    const ingresses = await this.prisma.ingress.findMany({
      where: { deploymentId },
      select: {
        namespace: true,
        service: { select: { name: true, port: true } },
      },
    });

    const selectors: string[] = [];
    for (const ingress of ingresses) {
      if (!ingress.service) continue;
      selectors.push(
        `${escapeRegex(ingress.service.name)}-${escapeRegex(ingress.namespace)}-${ingress.service.port}@kubernetes`,
      );
    }

    return selectors.length > 0 ? selectors.join('|') : null;
  }

  private async queryInstant(promql: string): Promise<number | null> {
    const params = new URLSearchParams({ query: promql });
    const url = `${this.vmBase}/api/v1/query?${params}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`VM query ${res.status}: ${await res.text()}`);
        return null;
      }
      const body = (await res.json()) as {
        status: string;
        data?: { resultType: string; result: Array<{ value: [number, string] }> };
      };
      if (body.status !== 'success' || !body.data?.result?.length) return null;
      const v = Number(body.data.result[0].value[1]);
      return Number.isFinite(v) ? v : null;
    } catch (err) {
      this.logger.warn(`VM query failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async queryRange(
    promql: string,
    startSec: number,
    endSec: number,
    stepSec: number,
  ): Promise<SeriesPoint[]> {
    const params = new URLSearchParams({
      query: promql,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    });
    const url = `${this.vmBase}/api/v1/query_range?${params}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`VM query_range ${res.status}: ${await res.text()}`);
        return [];
      }
      const body = (await res.json()) as {
        status: string;
        data?: {
          resultType: string;
          result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
        };
      };
      if (body.status !== 'success' || !body.data?.result?.length) return [];
      return body.data.result[0].values.map(([t, v]) => ({ x: t * 1000, y: Number(v) }));
    } catch (err) {
      this.logger.warn(`VM query_range failed: ${(err as Error).message}`);
      return [];
    }
  }
}

const TIMESTAMP_LEVEL_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\b\s*(.*)/i;

function parseLine(raw: string): LogEntry {
  const trimmed = raw.trim();

  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === 'object' && obj !== null) {
      const level =
        obj.level ?? obj.severity ?? obj.lvl ?? obj.log_level ?? undefined;
      const message =
        obj.msg ?? obj.message ?? obj.text ?? trimmed;
      const timestamp =
        obj.timestamp ?? obj.time ?? obj.ts ?? obj['@timestamp'] ?? undefined;
      const { level: _l, severity: _s, lvl: _v, log_level: _ll, msg: _m, message: _ms, text: _t, timestamp: _ts, time: _ti, ts: _tss, '@timestamp': _at, ...metadata } = obj;
      return {
        timestamp: timestamp != null ? String(timestamp) : undefined,
        level: level != null ? String(level).toUpperCase() : undefined,
        message: String(message),
        raw,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }
  } catch {}

  const match = TIMESTAMP_LEVEL_RE.exec(trimmed);
  if (match) {
    return {
      timestamp: match[1],
      level: normalizeLevel(match[2]),
      message: match[3],
      raw,
    };
  }

  return { message: trimmed, raw };
}

function normalizeLevel(s: string): string {
  const upper = s.toUpperCase();
  if (upper === 'WARNING') return 'WARN';
  return upper;
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LANGUAGE_PATTERNS: Array<{ re: RegExp; language: string; framework?: string }> = [
  { re: /\bdetected[:\s]+next\.?js\b/i, language: 'node', framework: 'nextjs' },
  { re: /\bdetected[:\s]+nuxt\b/i, language: 'node', framework: 'nuxt' },
  { re: /\bdetected[:\s]+remix\b/i, language: 'node', framework: 'remix' },
  { re: /\bdetected[:\s]+astro\b/i, language: 'node', framework: 'astro' },
  { re: /\bdetected[:\s]+sveltekit\b/i, language: 'node', framework: 'sveltekit' },
  { re: /\bdetected[:\s]+express\b/i, language: 'node', framework: 'express' },
  { re: /\bdetected[:\s]+fastify\b/i, language: 'node', framework: 'fastify' },
  { re: /\bdetected[:\s]+django\b/i, language: 'python', framework: 'django' },
  { re: /\bdetected[:\s]+flask\b/i, language: 'python', framework: 'flask' },
  { re: /\bdetected[:\s]+fast\s?api\b/i, language: 'python', framework: 'fastapi' },
  { re: /\bdetected[:\s]+rails\b/i, language: 'ruby', framework: 'rails' },
  { re: /\bdetected[:\s]+gin\b/i, language: 'go', framework: 'gin' },
  { re: /\bdetected[:\s]+echo\b/i, language: 'go', framework: 'echo' },
  { re: /\bdetected[:\s]+fiber\b/i, language: 'go', framework: 'fiber' },
  { re: /\bdetected[:\s]+spring\b/i, language: 'java', framework: 'spring' },
  { re: /\bdetected[:\s]+laravel\b/i, language: 'php', framework: 'laravel' },
  { re: /\bdetected[:\s]+phoenix\b/i, language: 'elixir', framework: 'phoenix' },
  { re: /\bdetected[:\s]+node\.?js\b/i, language: 'node' },
  { re: /\bdetected[:\s]+python\b/i, language: 'python' },
  { re: /\bdetected[:\s]+go(?:lang)?\b/i, language: 'go' },
  { re: /\bdetected[:\s]+ruby\b/i, language: 'ruby' },
  { re: /\bdetected[:\s]+java\b/i, language: 'java' },
  { re: /\bdetected[:\s]+\.?net\b/i, language: 'dotnet' },
  { re: /\bdetected[:\s]+rust\b/i, language: 'rust' },
  { re: /\bdetected[:\s]+php\b/i, language: 'php' },
  { re: /\bdetected[:\s]+elixir\b/i, language: 'elixir' },
];

const INSTALL_PATTERNS: Array<{ re: RegExp; language: string }> = [
  { re: /installing dependencies with (npm|yarn|pnpm)\b/i, language: 'node' },
  { re: /installing dependencies with pip\b/i, language: 'python' },
  { re: /installing dependencies with bundler\b/i, language: 'ruby' },
  { re: /installing dependencies with cargo\b/i, language: 'rust' },
  { re: /installing dependencies with composer\b/i, language: 'php' },
  { re: /installing dependencies with mix\b/i, language: 'elixir' },
  { re: /\bgo build\b/i, language: 'go' },
  { re: /\bmaven\b|\bgradle\b/i, language: 'java' },
  { re: /\bdotnet\s+(build|restore)\b/i, language: 'dotnet' },
];

const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/;

function detectFromBuildLogs(buildLogs: string | null): DetectedRuntime | null {
  if (!buildLogs) return null;

  const lines = buildLogs.split('\n');
  for (const line of lines) {
    for (const pat of LANGUAGE_PATTERNS) {
      if (pat.re.test(line)) {
        const versionMatch = VERSION_RE.exec(line);
        return {
          language: pat.language,
          framework: pat.framework ?? null,
          version: versionMatch?.[1] ?? null,
          confidence: 'high',
          detectedFrom: 'build_logs',
        };
      }
    }
  }

  for (const line of lines) {
    for (const pat of INSTALL_PATTERNS) {
      if (pat.re.test(line)) {
        const versionMatch = VERSION_RE.exec(line);
        return {
          language: pat.language,
          framework: null,
          version: versionMatch?.[1] ?? null,
          confidence: 'medium',
          detectedFrom: 'build_logs',
        };
      }
    }
  }

  return detectFromDockerBuildLogs(buildLogs);
}

const DOCKER_FROM_RE =
  /(?:^|\s)FROM\s+(?:docker\.io\/library\/)?(?:mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)[:@]|([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)[:@])/i;

const BUILDKIT_FROM_RE =
  /^#\d+\s+\[.*\]\s+FROM\s+(?:docker\.io\/library\/)?(?:mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)[:@]|([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)[:@])/i;

const FROM_IMAGE_MAP: Array<{ re: RegExp; language: string }> = [
  { re: /^node(?=[:\-@])/, language: 'node' },
  { re: /^python(?=[:\-@])/, language: 'python' },
  { re: /^golang(?=[:\-@])/, language: 'go' },
  { re: /^ruby(?=[:\-@])/, language: 'ruby' },
  { re: /^openjdk(?=[:\-@])/, language: 'java' },
  { re: /^eclipse-temurin(?=[:\-@])/, language: 'java' },
  { re: /^amazoncorretto(?=[:\-@])/, language: 'java' },
  { re: /^rust(?=[:\-@])/, language: 'rust' },
  { re: /^php(?=[:\-@])/, language: 'php' },
  { re: /^elixir(?=[:\-@])/, language: 'elixir' },
  { re: /^nginx(?=[:\-@])/, language: 'node' },
  { re: /^httpd(?=[:\-@])/, language: 'node' },
];

const DOCKER_FRAMEWORK_PATTERNS: Record<string, Array<{ re: RegExp; framework: string }>> = {
  node: [
    { re: /\bnext\s+build\b|\bnext\s+start\b|\bNEXT_/i, framework: 'nextjs' },
    { re: /\bnuxt\s+build\b|\bnuxt\s+start\b/i, framework: 'nuxt' },
    { re: /\bremix\s+build\b|\bremix-serve\b/i, framework: 'remix' },
    { re: /\bastro\s+build\b/i, framework: 'astro' },
    { re: /\bsvelte-kit\b|@sveltejs\b/i, framework: 'sveltekit' },
    { re: /\bfastify\b/i, framework: 'fastify' },
    { re: /\bexpress\b/i, framework: 'express' },
  ],
  python: [
    { re: /\bdjango\b|\bmanage\.py\b|\bgunicorn\b.*\bwsgi\b/i, framework: 'django' },
    { re: /\bfastapi\b|\buvicorn\b/i, framework: 'fastapi' },
    { re: /\bflask\b/i, framework: 'flask' },
  ],
  ruby: [
    { re: /\brails\b|\brake\b|\bpuma\b/i, framework: 'rails' },
  ],
  go: [
    { re: /\bgin-gonic\b/i, framework: 'gin' },
    { re: /\blabstack\/echo\b/i, framework: 'echo' },
    { re: /\bgofiber\/fiber\b/i, framework: 'fiber' },
  ],
  java: [
    { re: /\bspring\b/i, framework: 'spring' },
  ],
  php: [
    { re: /\blaravel\b|\bartisan\b/i, framework: 'laravel' },
  ],
};

const DOCKER_COPY_LANGUAGE: Array<{ re: RegExp; language: string }> = [
  { re: /\bCOPY\b.*\b(?:package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)\b/i, language: 'node' },
  { re: /\bCOPY\b.*\b(?:requirements\.txt|Pipfile|pyproject\.toml)\b/i, language: 'python' },
  { re: /\bCOPY\b.*\b(?:go\.mod|go\.sum)\b/i, language: 'go' },
  { re: /\bCOPY\b.*\bGemfile\b/i, language: 'ruby' },
  { re: /\bCOPY\b.*\b(?:Cargo\.toml|Cargo\.lock)\b/i, language: 'rust' },
  { re: /\bCOPY\b.*\bcomposer\.json\b/i, language: 'php' },
  { re: /\bCOPY\b.*\bmix\.exs\b/i, language: 'elixir' },
  { re: /\bCOPY\b.*\b(?:pom\.xml|build\.gradle)\b/i, language: 'java' },
  { re: /\bCOPY\b.*\b(?:\.csproj|\.sln)\b/i, language: 'dotnet' },
];

const DOCKER_RUN_LANGUAGE: Array<{ re: RegExp; language: string }> = [
  { re: /\bRUN\b.*\b(?:npm\s+install|yarn\s|pnpm\s+install)\b/i, language: 'node' },
  { re: /\bRUN\b.*\b(?:pip3?\s+install|poetry\s+install)\b/i, language: 'python' },
  { re: /\bRUN\b.*\b(?:go\s+build|go\s+mod\s+download)\b/i, language: 'go' },
  { re: /\bRUN\b.*\bbundle\s+install\b/i, language: 'ruby' },
  { re: /\bRUN\b.*\bcargo\s+build\b/i, language: 'rust' },
  { re: /\bRUN\b.*\bcomposer\s+install\b/i, language: 'php' },
  { re: /\bRUN\b.*\bmix\s+deps\.get\b/i, language: 'elixir' },
  { re: /\bRUN\b.*\b(?:mvn\b|gradle\b|\.\/gradlew\b)/i, language: 'java' },
  { re: /\bRUN\b.*\bdotnet\s+(?:restore|build)\b/i, language: 'dotnet' },
];

const FROM_VERSION_RE = /[:@](\d+(?:\.\d+(?:\.\d+)?)?)(?=-[a-zA-Z]|@|$)/;

function extractFromImageVersion(fromSegment: string): string | null {
  const match = FROM_VERSION_RE.exec(fromSegment);
  return match?.[1] ?? null;
}

function detectFromDockerBuildLogs(buildLogs: string): DetectedRuntime | null {
  const lines = buildLogs.split('\n');

  let language: string | null = null;
  let version: string | null = null;
  let isStaticServer = false;

  for (const line of lines) {
    let imageName: string | null = null;
    let rawFromSegment: string | null = null;

    const bkMatch = BUILDKIT_FROM_RE.exec(line);
    if (bkMatch) {
      const afterFrom = line.slice(line.search(/FROM\s+/i));
      rawFromSegment = afterFrom.replace(/^FROM\s+/i, '').split(/\s/)[0];
      const cleaned = rawFromSegment
        .replace(/^docker\.io\/library\//, '')
        .replace(/^mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)/, '');
      imageName = bkMatch[1] ?? cleaned;
    } else {
      const classicMatch = DOCKER_FROM_RE.exec(line);
      if (classicMatch) {
        const afterFrom = line.slice(line.search(/FROM\s+/i));
        rawFromSegment = afterFrom.replace(/^FROM\s+/i, '').split(/\s/)[0];
        const cleaned = rawFromSegment
          .replace(/^docker\.io\/library\//, '')
          .replace(/^mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)/, '');
        imageName = classicMatch[1] ?? cleaned;
      }
    }

    if (!imageName || !rawFromSegment) continue;

    if (/mcr\.microsoft\.com\/dotnet\//i.test(rawFromSegment)) {
      language = 'dotnet';
      version = extractFromImageVersion(rawFromSegment);
      break;
    }

    for (const pat of FROM_IMAGE_MAP) {
      if (pat.re.test(imageName)) {
        language = pat.language;
        isStaticServer = /^(?:nginx|httpd)(?=[:\-@])/.test(imageName);
        version = extractFromImageVersion(rawFromSegment);
        break;
      }
    }

    if (language) break;
  }

  if (!language) {
    for (const line of lines) {
      for (const pat of DOCKER_COPY_LANGUAGE) {
        if (pat.re.test(line)) {
          language = pat.language;
          break;
        }
      }
      if (language) break;
    }
  }

  if (!language) {
    for (const line of lines) {
      for (const pat of DOCKER_RUN_LANGUAGE) {
        if (pat.re.test(line)) {
          language = pat.language;
          break;
        }
      }
      if (language) break;
    }
  }

  if (!language) return null;

  if (isStaticServer) {
    return {
      language: 'node',
      framework: null,
      version: null,
      confidence: 'medium',
      detectedFrom: 'build_logs',
    };
  }

  let framework: string | null = null;
  const frameworkPatterns = DOCKER_FRAMEWORK_PATTERNS[language];
  if (frameworkPatterns) {
    for (const line of lines) {
      for (const pat of frameworkPatterns) {
        if (pat.re.test(line)) {
          framework = pat.framework;
          break;
        }
      }
      if (framework) break;
    }
  }

  return {
    language,
    framework,
    version,
    confidence: framework ? 'high' : 'medium',
    detectedFrom: 'build_logs',
  };
}

const ENV_RULES: Array<{
  test: (key: string) => boolean;
  language: string;
  framework?: string;
}> = [
  { test: (k) => k.startsWith('NEXT_PUBLIC_'), language: 'node', framework: 'nextjs' },
  { test: (k) => k.startsWith('NUXT_'), language: 'node', framework: 'nuxt' },
  { test: (k) => k === 'DJANGO_SETTINGS_MODULE', language: 'python', framework: 'django' },
  { test: (k) => k === 'FLASK_APP', language: 'python', framework: 'flask' },
  { test: (k) => k === 'RAILS_ENV', language: 'ruby', framework: 'rails' },
  { test: (k) => k === 'RACK_ENV', language: 'ruby' },
  { test: (k) => k === 'GIN_MODE', language: 'go', framework: 'gin' },
  { test: (k) => k === 'GOPATH', language: 'go' },
  { test: (k) => k === 'MIX_ENV', language: 'elixir' },
  { test: (k) => k.startsWith('ASPNETCORE_'), language: 'dotnet' },
  { test: (k) => k === 'NODE_ENV', language: 'node' },
];

function detectFromEnvVars(
  envVars: Array<{ key: string; value: string }>,
): DetectedRuntime | null {
  for (const env of envVars) {
    for (const rule of ENV_RULES) {
      if (rule.test(env.key)) {
        return {
          language: rule.language,
          framework: rule.framework ?? null,
          version: null,
          confidence: rule.framework ? 'medium' : 'low',
          detectedFrom: 'env_vars',
        };
      }
    }
  }
  return null;
}

const IMAGE_PATTERNS: Array<{ re: RegExp; language: string }> = [
  { re: /\bnode[:\-]/, language: 'node' },
  { re: /\bpython[:\-]/, language: 'python' },
  { re: /\bgolang[:\-]/, language: 'go' },
  { re: /\bruby[:\-]/, language: 'ruby' },
  { re: /\bopenjdk[:\-]/, language: 'java' },
  { re: /\bjava[:\-]/, language: 'java' },
  { re: /\bdotnet[:\-]/, language: 'dotnet' },
  { re: /\baspnet[:\-]/, language: 'dotnet' },
  { re: /\brust[:\-]/, language: 'rust' },
  { re: /\bphp[:\-]/, language: 'php' },
  { re: /\belixir[:\-]/, language: 'elixir' },
];

function detectFromImage(image: string | null): DetectedRuntime | null {
  if (!image) return null;

  const lower = image.toLowerCase();
  for (const pat of IMAGE_PATTERNS) {
    if (pat.re.test(lower)) {
      const versionMatch = VERSION_RE.exec(image);
      return {
        language: pat.language,
        framework: null,
        version: versionMatch?.[1] ?? null,
        confidence: 'medium',
        detectedFrom: 'image',
      };
    }
  }

  const lastSegment = lower.split('/').pop() ?? lower;
  for (const pat of IMAGE_PATTERNS) {
    if (pat.re.test(lastSegment)) {
      const versionMatch = VERSION_RE.exec(image);
      return {
        language: pat.language,
        framework: null,
        version: versionMatch?.[1] ?? null,
        confidence: 'low',
        detectedFrom: 'image',
      };
    }
  }

  return null;
}

const DOCKERFILE_PATH_PATTERNS: Array<{ re: RegExp; language: string }> = [
  { re: /\.node/i, language: 'node' },
  { re: /\.python/i, language: 'python' },
  { re: /\.go/i, language: 'go' },
  { re: /\.ruby/i, language: 'ruby' },
  { re: /\.java/i, language: 'java' },
  { re: /\.dotnet/i, language: 'dotnet' },
  { re: /\.rust/i, language: 'rust' },
  { re: /\.php/i, language: 'php' },
  { re: /\.elixir/i, language: 'elixir' },
];

function detectFromDockerfilePath(path: string | null): DetectedRuntime | null {
  if (!path) return null;

  for (const pat of DOCKERFILE_PATH_PATTERNS) {
    if (pat.re.test(path)) {
      return {
        language: pat.language,
        framework: null,
        version: null,
        confidence: 'low',
        detectedFrom: 'dockerfile',
      };
    }
  }
  return null;
}

function hasStackTraceStart(line: string): boolean {
  return (
    /Traceback \(most recent call last\):/i.test(line) ||
    /\bCaused by:/i.test(line) ||
    /^goroutine \d+/m.test(line)
  );
}

const STACK_FRAME_RE =
  /^\s+at\s|^\tat\s|^\s+File\s"|^Traceback\s|^Caused by:|^\s+\.{3}\s\d+\smore|^goroutine\s\d+|^\t\/.+\.go:\d+|^\t\/.+\.rb:\d+:in\s|^---\sEnd of\s/;

function isStackFrame(raw: string): boolean {
  return STACK_FRAME_RE.test(raw.trim());
}

const ERROR_TYPE_RE = /^(?:(\w+(?:\.\w+)*(?:Error|Exception|Fault|Panic))\s*[:\-]\s*)(.*)/;

function extractErrorInfo(msg: string): { type: string; message: string } {
  const match = ERROR_TYPE_RE.exec(msg.trim());
  if (match) {
    return { type: match[1], message: match[2] || match[1] };
  }
  return { type: 'Error', message: msg.trim() };
}

function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, '<timestamp>')
    .replace(/\b\d+\b/g, '<n>');
}
