import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import type {
  SandboxDesiredState,
  SandboxRunnerKind,
  SandboxStatus
} from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { KubernetesService } from '../core/kubernetes.service';
import { VictoriaMetricsService, escapeLabel } from '../core/victoria-metrics.service';
import { InstanceConfigService } from '../core/instance-config.service';
import { SANDBOX_RUNNERS } from '../core/instance-config.sections';
import { parseCpu, parseMemory } from '../core/quantity';
import { VolumeUsage, parseKubeletSummary, volumeKey } from '../core/volume-stats';
import { CRD_API_VERSION, CRD_KIND, SANDBOX_ID_LABEL, SANDBOX_SHARD } from './sandbox-cr';
import { KubernetesSandboxRunner } from './runners/kubernetes.runner';
import { VercelSandboxRunner } from './runners/vercel.runner';
import { SandboxRowLike, refOf } from './runners/sandbox-runner';
import { SandboxesService } from './sandboxes.service';
import { idleTimeoutMs, maxLifetimeMs } from './sandbox-reaper.service';

export const KUBERNETES_USAGE_TTL_MS = 15_000;
export const VERCEL_USAGE_TTL_MS = 30_000;
export const VERCEL_DISK_BYTES = 64 * 1024 ** 3;
export const VERCEL_MEMORY_PER_VCPU = 2 * 1024 ** 3;
const DEFAULT_VERCEL_VCPUS = 2;
const DEFAULT_VERCEL_TIMEOUT_MINUTES = 60;
const LOOKUP_TIMEOUT_MS = 8_000;
const EXEC_TIMEOUT_MS = 5_000;
const GUEST_FALLBACK_MIN_MS = 1_500;
const CACHE_LIMIT = 500;
const SECTION = '---';
const HOME = '/persist';

const CGROUP = '/sys/fs/cgroup';
const GUEST_SAMPLE_SECONDS = 0.4;

export const GUEST_STATS_SCRIPT = [
  `sample() { head -n 1 /proc/stat; read up _ < /proc/uptime; echo "uptime $up"; grep '^usage_usec ' ${CGROUP}/cpu.stat 2>/dev/null; }`,
  'sample',
  `echo ${SECTION}`,
  '{ df -B1 --output=used,size "$1" 2>/dev/null || df -B1 --output=used,size / 2>/dev/null; } | tail -n 1',
  `echo ${SECTION}`,
  'getconf CLK_TCK 2>/dev/null || echo 100',
  `echo ${SECTION}`,
  'cat /proc/net/dev',
  `echo ${SECTION}`,
  "nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo",
  `echo ${SECTION}`,
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  `for f in memory.current memory.max cpu.max; do [ -r ${CGROUP}/$f ] && echo "$f $(cat ${CGROUP}/$f)"; done`,
  `grep '^inactive_file ' ${CGROUP}/memory.stat 2>/dev/null`,
  `echo ${SECTION}`,
  `sleep ${GUEST_SAMPLE_SECONDS} 2>/dev/null || sleep 1`,
  'sample'
].join('; ');

export interface UsageDisk {
  usedBytes: number | null;
  capacityBytes: number | null;
}

export interface KubernetesUsage {
  cpu: {
    usedMillicores: number | null;
    limitMillicores: number | null;
    requestMillicores: number | null;
  };
  memory: { usedBytes: number | null; limitBytes: number | null };
  disk: UsageDisk;
}

export interface UsageCpu {
  usedCores: number | null;
  totalCores: number | null;
}

export interface UsageMemory {
  usedBytes: number | null;
  totalBytes: number | null;
}

export interface VercelUsage {
  vcpus: number | null;
  memoryBytes: number | null;
  cpu: UsageCpu;
  memory: UsageMemory;
  sessionExpiresAt: string | null;
  sessionTimeoutMinutes: number | null;
  activeCpuMs: number | null;
  totalActiveCpuMs: number | null;
  networkIngressBytes: number | null;
  networkEgressBytes: number | null;
  totalIngressBytes: number | null;
  totalEgressBytes: number | null;
  disk: UsageDisk;
}

export interface SandboxUsage {
  runner: SandboxRunnerKind;
  status: SandboxStatus;
  startedAt: string | null;
  uptimeSeconds: number | null;
  lastActiveAt: string | null;
  idleTimeoutMinutes: number | null;
  stopsAt: string | null;
  maxLifetimeHours: number | null;
  lifetimeEndsAt: string | null;
  machines: { count: number; limit: number | null } | null;
  kubernetes: KubernetesUsage | null;
  vercel: VercelUsage | null;
  fetchedAt: string;
}

export type UsageRow = SandboxRowLike & {
  status: SandboxStatus;
  desiredState: SandboxDesiredState;
  startedAt: Date | null;
  lastActiveAt: Date | null;
  cpuLimit: string;
  memoryLimit: string;
  diskSize: string;
};

export interface GuestStats {
  diskUsedBytes: number | null;
  diskSizeBytes: number | null;
  activeCpuMs: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  cpuUsedCores: number | null;
  cpuCores: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
}

interface VercelUsageView {
  status?: string;
  vcpus?: number;
  memory?: number;
  timeout?: number;
  expiresAt?: Date;
  activeCpuUsageMs?: number;
  totalActiveCpuDurationMs?: number;
  networkTransfer?: { ingress: number; egress: number };
  totalIngressBytes?: number;
  totalEgressBytes?: number;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function peek<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function quantity(value: unknown, parse: (v: string) => number): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = parse(value);
  return parsed > 0 ? parsed : null;
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function containerOf(spec: unknown): Record<string, any> | null {
  const containers = record(spec)?.containers;
  if (!Array.isArray(containers)) return null;
  return record(containers.find((c) => record(c)?.name === 'sandbox') ?? containers[0]);
}

function isPodLive(pod: Record<string, any> | null): boolean {
  return pod?.status?.phase === 'Running' && !pod?.metadata?.deletionTimestamp;
}

function iso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function dateMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface CpuSample {
  busy: number | null;
  total: number | null;
  uptime: number | null;
  usageUsec: number | null;
}

function cpuSample(section: string): CpuSample {
  const sample: CpuSample = { busy: null, total: null, uptime: null, usageUsec: null };
  for (const line of section.split('\n')) {
    const [name, ...rest] = line.trim().split(/\s+/);
    if (name === 'cpu' && rest.length >= 4) {
      const jiffies = rest.map(Number);
      if (!jiffies.slice(0, 4).every(Number.isFinite)) continue;
      const counted = jiffies.slice(0, 8).filter(Number.isFinite);
      const busy = [0, 1, 2, 5, 6].map((i) => jiffies[i]).filter(Number.isFinite);
      sample.busy = busy.reduce((a, b) => a + b, 0);
      sample.total = counted.reduce((a, b) => a + b, 0);
    } else if (name === 'uptime') {
      const value = Number(rest[0]);
      sample.uptime = rest[0] && Number.isFinite(value) ? value : null;
    } else if (name === 'usage_usec') {
      const value = Number(rest[0]);
      sample.usageUsec = rest[0] && Number.isFinite(value) ? value : null;
    }
  }
  return sample;
}

function keyed(section: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of section.split('\n')) {
    const [name, ...rest] = line.trim().split(/\s+/);
    if (name) out.set(name.replace(/:$/, ''), rest);
  }
  return out;
}

function positive(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cores(n: number): number {
  return Math.round(n * 100) / 100;
}

function guestCpu(
  first: CpuSample,
  last: CpuSample,
  online: number | null,
  quota: string[] | undefined
): { used: number | null; total: number | null } {
  const quotaUs = positive(quota?.[0]);
  const periodUs = positive(quota?.[1]);
  const limit = quotaUs !== null && periodUs !== null ? quotaUs / periodUs : null;
  const total = limit !== null && online !== null ? Math.min(limit, online) : (limit ?? online);
  const wall = first.uptime !== null && last.uptime !== null ? last.uptime - first.uptime : 0;
  if (first.usageUsec !== null && last.usageUsec !== null && wall > 0) {
    const used = (last.usageUsec - first.usageUsec) / 1e6 / wall;
    if (used >= 0) return { used: cores(used), total: total === null ? null : cores(total) };
  }
  if (
    online !== null &&
    first.busy !== null &&
    last.busy !== null &&
    first.total !== null &&
    last.total !== null &&
    last.total > first.total
  ) {
    const share = (last.busy - first.busy) / (last.total - first.total);
    if (share >= 0) {
      return {
        used: cores(Math.min(1, share) * online),
        total: total === null ? null : cores(total)
      };
    }
  }
  return { used: null, total: total === null ? null : cores(total) };
}

function guestMemory(fields: Map<string, string[]>): { used: number | null; total: number | null } {
  const memTotalKb = positive(fields.get('MemTotal')?.[0]);
  const availableKb = Number(fields.get('MemAvailable')?.[0]);
  const physical = memTotalKb === null ? null : memTotalKb * 1024;
  const current = Number(fields.get('memory.current')?.[0]);
  const limit = positive(fields.get('memory.max')?.[0]);
  if (limit !== null && Number.isFinite(current) && current >= 0) {
    const inactive = Number(fields.get('inactive_file')?.[0]);
    const used = Math.max(0, current - (Number.isFinite(inactive) ? inactive : 0));
    return { used, total: physical === null ? limit : Math.min(limit, physical) };
  }
  if (physical !== null && Number.isFinite(availableKb) && availableKb >= 0) {
    return { used: Math.max(0, physical - availableKb * 1024), total: physical };
  }
  return { used: null, total: physical };
}

function millicores(coresUsed: number | null): number | null {
  return coresUsed === null ? null : Math.round(coresUsed * 1000);
}

function guestVolume(stats: GuestStats | null): VolumeUsage | null {
  if (!stats || stats.diskUsedBytes === null) return null;
  return {
    usedBytes: stats.diskUsedBytes,
    capacityBytes: stats.diskSizeBytes ?? 0,
    availableBytes: null
  };
}

export function parseGuestStats(stdout: string): GuestStats {
  const sections = stdout.split(new RegExp(`^${SECTION}$`, 'm')).map((s) => s.trim());
  const [
    firstSample = '',
    dfLine = '',
    tickLine = '',
    netDev = '',
    nprocLine = '',
    memory = '',
    lastSample = ''
  ] = sections;
  const df = dfLine.split(/\s+/).map(Number);
  const diskUsedBytes = df.length === 2 && Number.isFinite(df[0]) ? df[0] : null;
  const diskSizeBytes = df.length === 2 && df[1] > 0 ? df[1] : null;
  const ticks = Number(tickLine) > 0 ? Number(tickLine) : 100;
  const first = cpuSample(firstSample);
  const last = cpuSample(lastSample);
  const activeCpuMs = first.busy === null ? null : Math.round((first.busy / ticks) * 1000);
  let rx = 0;
  let tx = 0;
  let interfaces = 0;
  for (const line of netDev.split('\n')) {
    const match = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!match || match[1] === 'lo') continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rx += fields[0];
    tx += fields[8];
    interfaces += 1;
  }
  const online = /^\d+$/.test(nprocLine) ? positive(nprocLine) : null;
  const fields = keyed(memory);
  const cpu = guestCpu(first, last, online, fields.get('cpu.max'));
  const mem = guestMemory(fields);
  return {
    diskUsedBytes,
    diskSizeBytes,
    activeCpuMs,
    rxBytes: interfaces ? rx : null,
    txBytes: interfaces ? tx : null,
    cpuUsedCores: cpu.used,
    cpuCores: cpu.total,
    memoryUsedBytes: mem.used,
    memoryTotalBytes: mem.total
  };
}

@Injectable()
export class SandboxUsageService {
  private readonly logger = new Logger(SandboxUsageService.name);

  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sandboxes: SandboxesService,
    private readonly kubernetes: KubernetesService,
    private readonly metrics: VictoriaMetricsService,
    private readonly config: InstanceConfigService,
    private readonly kubernetesRunner: KubernetesSandboxRunner,
    private readonly vercelRunner: VercelSandboxRunner
  ) {}

  async forSandbox(row: UsageRow): Promise<SandboxUsage> {
    const now = this.now();
    const running = row.status === 'running' && row.desiredState === 'running';
    const idleMs = idleTimeoutMs();
    const lifetimeMs = maxLifetimeMs();
    const startedMs = running && row.startedAt ? row.startedAt.getTime() : null;
    const lastActiveMs = row.lastActiveAt ? row.lastActiveAt.getTime() : null;
    const key = `${row.runner}:${row.id}:${running ? 'up' : 'down'}`;
    const [machines, kubernetes, vercel] = await Promise.all([
      this.machines(row.userId),
      row.runner === 'kubernetes'
        ? this.cached(key, KUBERNETES_USAGE_TTL_MS, () => this.kubernetesUsage(row, running))
        : Promise.resolve(null),
      row.runner === 'vercel'
        ? this.cached(key, VERCEL_USAGE_TTL_MS, () => this.vercelUsage(row, running))
        : Promise.resolve(null)
    ]);
    return {
      runner: row.runner,
      status: row.status,
      startedAt: iso(startedMs),
      uptimeSeconds: startedMs === null ? null : Math.max(0, Math.round((now - startedMs) / 1000)),
      lastActiveAt: iso(lastActiveMs),
      idleTimeoutMinutes: idleMs ? Math.round(idleMs / 60_000) : null,
      stopsAt: running && idleMs && lastActiveMs !== null ? iso(lastActiveMs + idleMs) : null,
      maxLifetimeHours: lifetimeMs ? Math.round(lifetimeMs / 3_600_000) : null,
      lifetimeEndsAt: startedMs !== null && lifetimeMs ? iso(startedMs + lifetimeMs) : null,
      machines,
      kubernetes,
      vercel,
      fetchedAt: new Date(now).toISOString()
    };
  }

  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < ttl) return hit.value as Promise<T>;
    const value = load();
    this.cache.delete(key);
    this.cache.set(key, { at: now, value });
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  private async machines(ownerId: string): Promise<SandboxUsage['machines']> {
    try {
      const [count, limit] = await Promise.all([
        this.prisma.sandbox.count({ where: { userId: ownerId, desiredState: { not: 'deleted' } } }),
        this.sandboxes.sandboxCap(ownerId)
      ]);
      return { count, limit };
    } catch (e: any) {
      this.logger.debug(`machine count unavailable for ${ownerId}: ${e?.message}`);
      return null;
    }
  }

  private get mirrorDisabled(): boolean {
    return process.env.ENGINE_DISABLED === 'true' || process.env.MIRROR_DISABLED === 'true';
  }

  private async mirrored(row: UsageRow, namespace: string) {
    if (this.mirrorDisabled) return { cr: null, pod: null, claims: [] as Record<string, any>[] };
    const byLabel = { path: ['metadata', 'labels', SANDBOX_ID_LABEL], equals: row.id };
    const [cr, pods, claims] = await Promise.all([
      this.prisma.k8sObject.findUnique({
        where: {
          kind_namespace_name_apiVersion: {
            kind: CRD_KIND,
            namespace,
            name: row.podName,
            apiVersion: CRD_API_VERSION
          }
        },
        select: { manifest: true }
      }),
      this.prisma.k8sObject.findMany({
        where: { kind: 'Pod', namespace, shard: SANDBOX_SHARD, manifest: byLabel },
        select: { manifest: true }
      }),
      this.prisma.k8sObject.findMany({
        where: {
          kind: 'PersistentVolumeClaim',
          namespace,
          shard: SANDBOX_SHARD,
          manifest: byLabel
        },
        select: { manifest: true }
      })
    ]);
    const pod = pods.map((p) => record(p.manifest)).find((p) => isPodLive(p)) ?? null;
    return {
      cr: record(cr?.manifest),
      pod,
      claims: claims.map((c) => record(c.manifest)).filter((c): c is Record<string, any> => !!c)
    };
  }

  async kubernetesUsage(row: UsageRow, running: boolean): Promise<KubernetesUsage> {
    const namespace = row.namespace || this.kubernetesRunner.namespace;
    const { cr, pod, claims } = await this.mirrored(row, namespace).catch((e: any) => {
      this.logger.debug(`mirror read failed for sandbox ${row.id}: ${e?.message}`);
      return { cr: null, pod: null, claims: [] as Record<string, any>[] };
    });
    const container = containerOf(pod?.spec) ?? containerOf(cr?.spec?.podTemplate?.spec);
    const resources = record(container?.resources);
    const homeVolume = Array.isArray(pod?.spec?.volumes)
      ? pod.spec.volumes.find((v: any) => v?.name === 'home')
      : null;
    const claimName: string | null = homeVolume?.persistentVolumeClaim?.claimName ?? null;
    const claim =
      (claimName ? claims.find((c) => c.metadata?.name === claimName) : null) ?? claims[0] ?? null;
    const usage: KubernetesUsage = {
      cpu: {
        usedMillicores: null,
        limitMillicores:
          quantity(resources?.limits?.cpu, parseCpu) ?? quantity(row.cpuLimit, parseCpu),
        requestMillicores: quantity(resources?.requests?.cpu, parseCpu)
      },
      memory: {
        usedBytes: null,
        limitBytes:
          quantity(resources?.limits?.memory, parseMemory) ?? quantity(row.memoryLimit, parseMemory)
      },
      disk: {
        usedBytes: null,
        capacityBytes:
          quantity(claim?.status?.capacity?.storage, parseMemory) ??
          quantity(claim?.spec?.resources?.requests?.storage, parseMemory) ??
          quantity(row.diskSize, parseMemory)
      }
    };
    const podName = typeof pod?.metadata?.name === 'string' ? pod.metadata.name : null;
    if (!running || !podName) return usage;
    const selector = `namespace="${escapeLabel(namespace)}",pod="${escapeLabel(podName)}",container="",image=""`;
    const block = claim?.spec?.volumeMode === 'Block';
    const pvcName = claimName ?? claim?.metadata?.name ?? null;
    const started = this.now();
    const early = block ? this.guestStats(row, HOME) : null;
    const [cpu, memory, volume] = await Promise.all([
      withTimeout(
        this.metrics.queryInstant(
          `sum(rate(container_cpu_usage_seconds_total{${selector}}[2m])) * 1000`
        ),
        LOOKUP_TIMEOUT_MS
      ).catch(() => null),
      withTimeout(
        this.metrics.queryInstant(`sum(container_memory_working_set_bytes{${selector}})`),
        LOOKUP_TIMEOUT_MS
      ).catch(() => null),
      block ? null : this.kubeletVolume(pod?.spec?.nodeName, namespace, pvcName)
    ]);
    const cpuUsed = finite(cpu);
    usage.cpu.usedMillicores = cpuUsed === null ? null : Math.round(cpuUsed);
    usage.memory.usedBytes = finite(memory);
    let guest = early ? await early : null;
    if (!guest && (usage.cpu.usedMillicores === null || usage.memory.usedBytes === null)) {
      const remaining = LOOKUP_TIMEOUT_MS - (this.now() - started);
      if (remaining >= GUEST_FALLBACK_MIN_MS) {
        guest = await withTimeout(this.guestStats(row, HOME), remaining).catch(() => null);
      }
    }
    if (guest) {
      usage.cpu.usedMillicores ??= millicores(guest.cpuUsedCores);
      usage.cpu.limitMillicores ??= millicores(guest.cpuCores);
      usage.memory.usedBytes ??= guest.memoryUsedBytes;
      usage.memory.limitBytes ??= guest.memoryTotalBytes;
    }
    const disk = block ? guestVolume(guest) : volume;
    if (disk) {
      usage.disk.usedBytes = finite(disk.usedBytes);
      usage.disk.capacityBytes = finite(disk.capacityBytes) || usage.disk.capacityBytes;
    }
    return usage;
  }

  async kubeletSummary(node: string): Promise<unknown> {
    const kc = this.kubernetes.kc;
    if (!kc) return null;
    const res: any = await kc
      .makeApiClient(k8s.CoreV1Api)
      .connectGetNodeProxyWithPath(node, 'stats/summary');
    const raw = res?.body;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  private async kubeletVolume(
    node: unknown,
    namespace: string,
    pvcName: string | null
  ): Promise<VolumeUsage | null> {
    if (typeof node !== 'string' || !node || !pvcName) return null;
    try {
      const summary = await withTimeout(this.kubeletSummary(node), LOOKUP_TIMEOUT_MS);
      return parseKubeletSummary(summary).get(volumeKey(namespace, pvcName)) ?? null;
    } catch (e: any) {
      this.logger.debug(`kubelet volume stats for ${node} unavailable: ${e?.message}`);
      return null;
    }
  }

  private async guestStats(row: UsageRow, path: string): Promise<GuestStats | null> {
    const runner = row.runner === 'vercel' ? this.vercelRunner : this.kubernetesRunner;
    try {
      const result = await withTimeout(
        runner.exec(refOf(row), ['/bin/sh', '-c', GUEST_STATS_SCRIPT, 'sh', path], {
          timeoutMs: EXEC_TIMEOUT_MS
        }),
        EXEC_TIMEOUT_MS + 1_000
      );
      return result.ok ? parseGuestStats(result.stdout) : null;
    } catch (e: any) {
      this.logger.debug(`guest stats unavailable for sandbox ${row.id}: ${e?.message}`);
      return null;
    }
  }

  private vercelSetting(name: string): string | null {
    return this.config.value(SANDBOX_RUNNERS, name)?.trim() || null;
  }

  private vercelCredentials(): { token: string; teamId: string; projectId: string } | null {
    if (this.vercelRunner.configError()) return null;
    const token = this.vercelSetting('vercelToken');
    const teamId = this.vercelSetting('vercelTeamId');
    const projectId = this.vercelSetting('vercelProjectId');
    return token && teamId && projectId ? { token, teamId, projectId } : null;
  }

  async vercelUsage(row: UsageRow, running: boolean): Promise<VercelUsage> {
    const configuredVcpus = Math.floor(Number(this.vercelSetting('vercelVcpus')));
    const vcpus = configuredVcpus > 0 ? configuredVcpus : DEFAULT_VERCEL_VCPUS;
    const configuredTimeout = Number(this.vercelSetting('vercelTimeoutMinutes'));
    const state = record(row.runnerState);
    const usage: VercelUsage = {
      vcpus,
      memoryBytes: vcpus * VERCEL_MEMORY_PER_VCPU,
      cpu: { usedCores: null, totalCores: null },
      memory: { usedBytes: null, totalBytes: null },
      sessionExpiresAt: running ? iso(dateMs(state?.expiresAt)) : null,
      sessionTimeoutMinutes:
        configuredTimeout > 0 ? configuredTimeout : DEFAULT_VERCEL_TIMEOUT_MINUTES,
      activeCpuMs: null,
      totalActiveCpuMs: null,
      networkIngressBytes: null,
      networkEgressBytes: null,
      totalIngressBytes: null,
      totalEgressBytes: null,
      disk: { usedBytes: null, capacityBytes: VERCEL_DISK_BYTES }
    };
    const credentials = this.vercelCredentials();
    let live = false;
    if (credentials) {
      try {
        const sandbox = (await withTimeout(
          this.vercelRunner.sdk.get({
            name: row.podName,
            resume: false,
            ...credentials,
            signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
          }),
          LOOKUP_TIMEOUT_MS
        )) as unknown as VercelUsageView;
        live = peek(() => sandbox.status) === 'running';
        const sdkVcpus = finite(peek(() => sandbox.vcpus));
        const memoryMb = finite(peek(() => sandbox.memory));
        if (sdkVcpus) usage.vcpus = sdkVcpus;
        usage.memoryBytes = memoryMb
          ? memoryMb * 1024 * 1024
          : (usage.vcpus ?? vcpus) * VERCEL_MEMORY_PER_VCPU;
        const timeoutMs = finite(peek(() => sandbox.timeout));
        if (timeoutMs) usage.sessionTimeoutMinutes = Math.round(timeoutMs / 60_000);
        const expires = dateMs(peek(() => sandbox.expiresAt));
        if (running && live && expires !== null) usage.sessionExpiresAt = iso(expires);
        usage.activeCpuMs = finite(peek(() => sandbox.activeCpuUsageMs));
        usage.totalActiveCpuMs = finite(peek(() => sandbox.totalActiveCpuDurationMs));
        const transfer = record(peek(() => sandbox.networkTransfer));
        usage.networkIngressBytes = finite(transfer?.ingress);
        usage.networkEgressBytes = finite(transfer?.egress);
        usage.totalIngressBytes = finite(peek(() => sandbox.totalIngressBytes));
        usage.totalEgressBytes = finite(peek(() => sandbox.totalEgressBytes));
      } catch (e: any) {
        this.logger.debug(`vercel usage unavailable for sandbox ${row.id}: ${e?.message}`);
      }
    }
    usage.cpu.totalCores = usage.vcpus;
    usage.memory.totalBytes = usage.memoryBytes;
    if (!running || !live) return usage;
    const guest = await this.guestStats(row, HOME);
    if (!guest) return usage;
    usage.cpu.usedCores = guest.cpuUsedCores;
    usage.cpu.totalCores ??= guest.cpuCores;
    usage.memory.usedBytes = guest.memoryUsedBytes;
    usage.memory.totalBytes ??= guest.memoryTotalBytes;
    usage.disk.usedBytes = guest.diskUsedBytes;
    if (guest.diskSizeBytes) usage.disk.capacityBytes = guest.diskSizeBytes;
    usage.activeCpuMs ??= guest.activeCpuMs;
    usage.networkIngressBytes ??= guest.rxBytes;
    usage.networkEgressBytes ??= guest.txBytes;
    return usage;
  }
}
