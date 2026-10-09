import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import type { SandboxDesiredState, SandboxRunnerKind, SandboxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { VictoriaMetricsService, escapeLabel } from '../metrics/victoria-metrics.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { SANDBOX_RUNNERS } from '../instance-config/instance-config.sections';
import { parseCpu, parseMemory } from '../kubernetes/quantity';
import { VolumeUsage, parseKubeletSummary, volumeKey } from '../kubernetes/volume-stats';
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
const CACHE_LIMIT = 500;
const SECTION = '---';
const HOME = '/persist';

export const GUEST_STATS_SCRIPT = [
  '{ df -B1 --output=used,size "$1" 2>/dev/null || df -B1 --output=used,size / 2>/dev/null; } | tail -n 1',
  `echo ${SECTION}`,
  'getconf CLK_TCK 2>/dev/null || echo 100',
  `echo ${SECTION}`,
  'head -n 1 /proc/stat',
  `echo ${SECTION}`,
  'cat /proc/net/dev'
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

export interface VercelUsage {
  vcpus: number | null;
  memoryBytes: number | null;
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

export function parseGuestStats(stdout: string): GuestStats {
  const sections = stdout.split(new RegExp(`^${SECTION}$`, 'm')).map((s) => s.trim());
  const [dfLine = '', tickLine = '', statLine = '', netDev = ''] = sections;
  const df = dfLine.split(/\s+/).map(Number);
  const diskUsedBytes = df.length === 2 && Number.isFinite(df[0]) ? df[0] : null;
  const diskSizeBytes = df.length === 2 && df[1] > 0 ? df[1] : null;
  const ticks = Number(tickLine) > 0 ? Number(tickLine) : 100;
  let activeCpuMs: number | null = null;
  const stat = statLine.split(/\s+/);
  if (stat[0] === 'cpu' && stat.length >= 5) {
    const jiffies = stat.slice(1).map(Number);
    const busy = [0, 1, 2, 5, 6].map((i) => jiffies[i]).filter(Number.isFinite);
    if (busy.length >= 3) {
      activeCpuMs = Math.round((busy.reduce((a, b) => a + b, 0) / ticks) * 1000);
    }
  }
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
  return {
    diskUsedBytes,
    diskSizeBytes,
    activeCpuMs,
    rxBytes: interfaces ? rx : null,
    txBytes: interfaces ? tx : null
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
    return process.env.MIRROR_DISABLED === 'true';
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
    const [cpu, memory, disk] = await Promise.all([
      this.metrics
        .queryInstant(`sum(rate(container_cpu_usage_seconds_total{${selector}}[2m])) * 1000`)
        .catch(() => null),
      this.metrics
        .queryInstant(`sum(container_memory_working_set_bytes{${selector}})`)
        .catch(() => null),
      block
        ? this.guestDisk(row, HOME)
        : this.kubeletVolume(pod?.spec?.nodeName, namespace, pvcName)
    ]);
    const cpuUsed = finite(cpu);
    usage.cpu.usedMillicores = cpuUsed === null ? null : Math.round(cpuUsed);
    usage.memory.usedBytes = finite(memory);
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
      const result = await runner.exec(
        refOf(row),
        ['/bin/sh', '-c', GUEST_STATS_SCRIPT, 'sh', path],
        {
          timeoutMs: EXEC_TIMEOUT_MS
        }
      );
      return result.ok ? parseGuestStats(result.stdout) : null;
    } catch (e: any) {
      this.logger.debug(`guest stats unavailable for sandbox ${row.id}: ${e?.message}`);
      return null;
    }
  }

  private async guestDisk(row: UsageRow, path: string): Promise<VolumeUsage | null> {
    const stats = await this.guestStats(row, path);
    if (!stats || stats.diskUsedBytes === null) return null;
    return {
      usedBytes: stats.diskUsedBytes,
      capacityBytes: stats.diskSizeBytes ?? 0,
      availableBytes: null
    };
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
    if (!running || !live) return usage;
    const guest = await this.guestStats(row, HOME);
    if (!guest) return usage;
    usage.disk.usedBytes = guest.diskUsedBytes;
    if (guest.diskSizeBytes) usage.disk.capacityBytes = guest.diskSizeBytes;
    usage.activeCpuMs ??= guest.activeCpuMs;
    usage.networkIngressBytes ??= guest.rxBytes;
    usage.networkEgressBytes ??= guest.txBytes;
    return usage;
  }
}
