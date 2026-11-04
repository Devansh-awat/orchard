import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { merge, Subscription } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { PodLogCaptureService } from '../kubernetes/pod-log-capture.service';
import { OrgEventsService } from '../events/org-events.service';
import { summarizeBuildFailure } from '../docker/build-summary';
import { scrubIngress } from './projects.utils';
import { portRefused } from './port-refused';
import {
  deriveRolloutPhase,
  type FailingPod,
  type RolloutPhase,
  type RolloutPin,
  type RolloutVerdict
} from './rollout-phase';

export {
  deriveRolloutPhase,
  type RolloutPhase,
  type RolloutPin,
  type RolloutVerdict
} from './rollout-phase';

export const ROLLOUT_WAIT_MAX_MS = 120_000;
export const ROLLOUT_WAIT_DEFAULT_MS = 60_000;
const POLL_MS = 2_000;
const COALESCE_MS = 250;
const BUILD_TAIL_LINES = 40;
const POD_TAIL_LINES = 30;
const MAX_POD_TAILS = 3;
const LOG_FETCH_TIMEOUT_MS = 5_000;
const BUILD_LOG_TAIL_CHARS = 16_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RolloutQuery {
  canEdit: boolean;
  wait: boolean;
  timeoutMs: number;
  releaseId?: string;
  since?: string;
  signal?: AbortSignal;
}

export interface RolloutFailingPod extends FailingPod {
  logTail: string[];
}

export interface RolloutStatus {
  phase: RolloutPhase;
  terminal: boolean;
  releaseId: string | null;
  url: string | null;
  build: { status: string | null; step: string | null; error: string | null; logTail: string[] };
  pods: { desired: number; ready: number; failing: RolloutFailingPod[] };
  hint: string | null;
}

interface Snapshot {
  verdict: RolloutVerdict;
  name: string;
  namespace: string;
  buildStatus: string | null;
  buildStep: string | null;
  buildError: string | null;
}

export function tailLines(text: string | null | undefined, n: number): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n);
}

export function pendingBuildHint(phase: RolloutPhase, buildTail: string): string | null {
  if (phase !== 'queued' && phase !== 'building') return null;
  const last = tailLines(buildTail, 1)[0] ?? '';
  const match = /still pending after \d+s \((.+)\) - waiting for pod to be scheduled/.exec(last);
  return match ? `The build is waiting for a place to run: ${match[1]}` : null;
}

export function parseRolloutTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === '') return ROLLOUT_WAIT_DEFAULT_MS;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) {
    throw new BadRequestException('timeout must be a positive number of seconds');
  }
  return Math.min(Math.round(secs * 1000), ROLLOUT_WAIT_MAX_MS);
}

export function parseRolloutSince(raw: string | undefined): Date | null {
  if (!raw) return null;
  const asNumber = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const d = Number.isFinite(asNumber) ? new Date(asNumber) : new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('since must be an ISO timestamp or epoch milliseconds');
  }
  return d;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

@Injectable()
export class RolloutStatusService {
  private readonly refused = portRefused;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly logCapture: PodLogCaptureService,
    private readonly orgEvents: OrgEventsService
  ) {}

  async rollout(deploymentId: string, q: RolloutQuery): Promise<RolloutStatus> {
    const pinned = await this.resolvePin(deploymentId, q.releaseId, q.since);
    let snap = await this.evaluate(deploymentId, pinned.pin);
    if (q.wait && !snap.verdict.terminal) {
      snap = await this.waitForTerminal(deploymentId, pinned.pin, snap, q);
    }
    return this.present(deploymentId, snap, pinned.releaseId, q.canEdit);
  }

  async rolloutPin(deploymentId: string, since: Date) {
    const release = await this.prisma.release.findFirst({
      where: { deploymentId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    });
    return { rolloutSince: since.toISOString(), releaseId: release?.id ?? null };
  }

  private async resolvePin(
    deploymentId: string,
    releaseId: string | undefined,
    sinceRaw: string | undefined
  ): Promise<{ pin: RolloutPin | null; releaseId: string | null }> {
    const since = parseRolloutSince(sinceRaw);
    if (releaseId) {
      if (!UUID_RE.test(releaseId)) throw new BadRequestException('release must be a release id');
      const release = await this.prisma.release.findFirst({
        where: { id: releaseId, deploymentId },
        select: { id: true, image: true, status: true, reason: true, createdAt: true }
      });
      if (!release) throw new NotFoundException('Release not found for this deployment');
      const newer = await this.prisma.release.count({
        where: { deploymentId, createdAt: { gt: release.createdAt } }
      });
      const pinSince =
        since && since.getTime() > release.createdAt.getTime() ? since : release.createdAt;
      return {
        releaseId: release.id,
        pin: {
          since: pinSince,
          image: newer === 0 ? release.image : null,
          releaseStatus: release.status,
          releaseReason: release.reason
        }
      };
    }
    const latest = await this.prisma.release.findFirst({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    });
    return {
      releaseId: latest?.id ?? null,
      pin: since ? { since, image: null, releaseStatus: null, releaseReason: null } : null
    };
  }

  private async evaluate(deploymentId: string, pin: RolloutPin | null): Promise<Snapshot> {
    const d = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        name: true,
        namespace: true,
        stopped: true,
        replicas: true,
        image: true,
        buildStatus: true,
        buildStep: true,
        buildError: true,
        updatedAt: true
      }
    });
    if (!d) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    const [runs, workload, podRows] = await Promise.all([
      this.prisma.buildRun.findMany({
        where: { deploymentId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { status: true, finishedAt: true }
      }),
      d.namespace && d.name
        ? this.prisma.k8sObject.findFirst({
            where: { kind: 'Deployment', namespace: d.namespace, name: d.name },
            select: { manifest: true, syncedAt: true }
          })
        : Promise.resolve(null),
      this.prisma.k8sObject.findMany({
        where: { kind: 'Pod', deploymentId },
        select: { manifest: true }
      })
    ]);
    const active =
      runs.find((r) => r.status === 'building') ?? runs.find((r) => r.status === 'scheduled');
    const lastFinished = runs
      .map((r) => r.finishedAt)
      .filter((t): t is Date => !!t)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const verdict = deriveRolloutPhase({
      deployment: {
        stopped: d.stopped,
        replicas: d.replicas,
        image: d.image,
        buildStatus: d.buildStatus,
        buildStep: d.buildStep,
        buildError: d.buildError,
        updatedAt: d.updatedAt
      },
      activeBuildRun: active ? { status: active.status } : null,
      lastBuildFinishedAt: lastFinished ?? null,
      workload: workload ? { manifest: workload.manifest, syncedAt: workload.syncedAt } : null,
      pods: podRows.map((p) => p.manifest),
      pin,
      now: new Date()
    });
    return {
      verdict,
      name: d.name,
      namespace: d.namespace,
      buildStatus: d.buildStatus,
      buildStep: d.buildStep,
      buildError: d.buildError
    };
  }

  private async waitForTerminal(
    deploymentId: string,
    pin: RolloutPin | null,
    first: Snapshot,
    q: RolloutQuery
  ): Promise<Snapshot> {
    const deadline = Date.now() + q.timeoutMs;
    let dirty = false;
    let wake: (() => void) | null = null;
    const sub: Subscription = merge(
      this.orgEvents.forDeployment('build.changed', deploymentId),
      this.orgEvents.forDeployment('deployment.changed', deploymentId),
      this.orgEvents.forDeployment('pod.changed', deploymentId)
    ).subscribe(() => {
      dirty = true;
      wake?.();
    });
    let snap = first;
    try {
      while (!snap.verdict.terminal && !q.signal?.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        if (!dirty) {
          await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = () => {
              if (timer) clearTimeout(timer);
              q.signal?.removeEventListener('abort', done);
              wake = null;
              resolve();
            };
            timer = setTimeout(done, Math.min(POLL_MS, remaining));
            wake = done;
            q.signal?.addEventListener('abort', done, { once: true });
          });
          if (dirty) await new Promise((r) => setTimeout(r, COALESCE_MS));
        }
        dirty = false;
        if (q.signal?.aborted) break;
        snap = await this.evaluate(deploymentId, pin);
      }
    } finally {
      sub.unsubscribe();
    }
    return snap;
  }

  private async present(
    deploymentId: string,
    snap: Snapshot,
    releaseId: string | null,
    canEdit: boolean
  ): Promise<RolloutStatus> {
    const v = snap.verdict;
    const [url, buildTail, podTails, portHint] = await Promise.all([
      this.primaryUrl(deploymentId),
      canEdit ? this.buildLogTail(deploymentId) : Promise.resolve(''),
      canEdit && v.failing.length > 0
        ? this.podLogTails(deploymentId, snap.namespace, v.failing.slice(0, MAX_POD_TAILS))
        : Promise.resolve(new Map<string, string[]>()),
      canEdit && v.phase === 'live'
        ? this.silentPortHint(deploymentId, snap.namespace)
        : Promise.resolve(null)
    ]);
    const failed = (snap.buildStatus ?? '').toLowerCase() === 'failed';
    const error = canEdit
      ? snap.buildError || (failed && buildTail ? summarizeBuildFailure(buildTail) : null)
      : null;
    return {
      phase: v.phase,
      terminal: v.terminal,
      releaseId,
      url,
      build: {
        status: snap.buildStatus,
        step: snap.buildStep,
        error: error || null,
        logTail: canEdit ? tailLines(buildTail, BUILD_TAIL_LINES) : []
      },
      pods: {
        desired: v.desired,
        ready: v.ready,
        failing: v.failing.map((f) => ({ ...f, logTail: podTails.get(f.pod) ?? [] }))
      },
      hint: v.hint ?? pendingBuildHint(v.phase, buildTail) ?? portHint
    };
  }

  private async silentPortHint(deploymentId: string, namespace: string): Promise<string | null> {
    const rows = await this.prisma.ingress.findMany({
      where: { deploymentId, redirectTarget: null },
      orderBy: { createdAt: 'asc' },
      include: { service: { select: { name: true, port: true, protocol: true } } }
    });
    const routed = rows.find((row) => row.service);
    if (!routed?.service || routed.service.protocol !== 'TCP') return null;
    const port = routed.servicePort ?? routed.service.port;
    const host = `${routed.service.name}.${namespace}.svc.cluster.local`;
    if (!(await this.refused(host, port))) return null;
    return `Nothing is listening on port ${port} yet, so the URL returns 502. If the app listens on another port, change it under Network in the dashboard, or with: orchard service update`;
  }

  private async primaryUrl(deploymentId: string): Promise<string | null> {
    const rows = await this.prisma.ingress.findMany({
      where: { deploymentId, redirectTarget: null },
      orderBy: { createdAt: 'asc' }
    });
    for (const row of rows) {
      const url = scrubIngress(row).url;
      if (url) return url;
    }
    return null;
  }

  private async buildLogTail(deploymentId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ tail: string | null }[]>`
      SELECT right("build_logs", ${BUILD_LOG_TAIL_CHARS}::int) AS tail
      FROM "deployments" WHERE "id" = ${deploymentId}::uuid`;
    return rows[0]?.tail ?? '';
  }

  private async podLogTails(
    deploymentId: string,
    namespace: string,
    failing: FailingPod[]
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const captured = await withTimeout(this.logCapture.list(deploymentId), 2_000, []);
    await Promise.all(
      failing.map(async (f) => {
        const container = f.container ?? undefined;
        const previous = await withTimeout(
          this.k8sWorkload.getPodLogs(f.pod, namespace, container, POD_TAIL_LINES, true),
          LOG_FETCH_TIMEOUT_MS,
          null as any
        );
        let lines = tailLines(previous?.logs, POD_TAIL_LINES);
        if (lines.length === 0) {
          const current = await withTimeout(
            this.k8sWorkload.getPodLogs(f.pod, namespace, container, POD_TAIL_LINES, false),
            LOG_FETCH_TIMEOUT_MS,
            null as any
          );
          lines = tailLines(current?.logs, POD_TAIL_LINES);
        }
        if (lines.length === 0) {
          const entry = captured.find((c) => c.pod === f.pod);
          if (entry) {
            const logs = await withTimeout(
              this.logCapture.getLogs(deploymentId, entry.entryId),
              2_000,
              null
            );
            lines = tailLines(logs?.logs, POD_TAIL_LINES);
          }
        }
        out.set(f.pod, lines);
      })
    );
    return out;
  }
}
