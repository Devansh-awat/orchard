import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import * as crypto from 'crypto';
import { LeaseService } from '../coordination/lease.service';
import {
  check,
  errorMessage,
  summarize,
  type DoctorCheck,
  type DoctorSummary
} from './doctor.types';
import {
  buildTargets,
  checksFromResults,
  parseProbeLog,
  probeInput,
  resolveTargets,
  type Outcome,
  type ProbeTarget,
  type TargetResult
} from './selftest.plan';
import { SELFTEST_LABEL } from './cluster-reader';
import { SelfTestClusterFactory } from './selftest.cluster';
import type { PodState, SelfTestCluster, SelfTestTimeouts, NamespaceShape } from './selftest.types';
import { LISTENER_PORT } from './selftest.types';

export const REAPER_MAX_AGE_MS = 10 * 60 * 1000;
const REAPER_INTERVAL_MS = 10 * 60 * 1000;
const KEEP_RUNS = 10;

export type SelfTestStatus = 'running' | 'done' | 'error';

export interface SelfTestRun {
  id: string;
  status: SelfTestStatus;
  phase: string;
  startedAt: string;
  startedBy: string | null;
  finishedAt: string | null;
  checks: DoctorCheck[];
  summary: DoctorSummary;
  targets: TargetResult[];
  notes: string[];
  error: string | null;
  leftovers: string[];
}

export const DEFAULT_TIMEOUTS: SelfTestTimeouts = {
  listenerMs: 150_000,
  probeMs: 150_000,
  deleteMs: 90_000,
  pollMs: 2_000
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class SelfTestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SelfTestService.name);

  private readonly runs = new Map<string, SelfTestRun>();

  private readonly tasks = new Map<string, Promise<void>>();

  private active: string | null = null;

  private timer: NodeJS.Timeout | null = null;

  timeouts: SelfTestTimeouts = { ...DEFAULT_TIMEOUTS };

  constructor(
    private readonly factory: SelfTestClusterFactory,
    private readonly lease: LeaseService
  ) {}

  onModuleInit(): void {
    if (!this.lease.canCoordinate) return;
    this.timer = setInterval(() => {
      this.reapOrphans().catch(() => {});
    }, REAPER_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  start(startedBy: string | null): SelfTestRun {
    if (this.active) {
      throw new ConflictException({
        error: 'A self-test is already running',
        message: `Self-test ${this.active} has not finished.`,
        id: this.active
      });
    }
    const cluster = this.factory.create();
    const run: SelfTestRun = {
      id: `st-${crypto.randomBytes(5).toString('hex')}`,
      status: 'running',
      phase: 'starting',
      startedAt: new Date().toISOString(),
      startedBy,
      finishedAt: null,
      checks: [],
      summary: { pass: 0, warn: 0, fail: 0, unknown: 0 },
      targets: [],
      notes: [],
      error: null,
      leftovers: []
    };
    this.runs.set(run.id, run);
    this.active = run.id;
    this.trim();
    const task = this.execute(run, cluster)
      .catch((error) => {
        run.status = 'error';
        run.error = errorMessage(error);
        this.logger.error(`self-test ${run.id} failed: ${run.error}`);
      })
      .finally(() => {
        run.finishedAt = new Date().toISOString();
        run.summary = summarize(run.checks);
        if (run.status === 'running') run.status = 'done';
        this.active = null;
      });
    this.tasks.set(run.id, task);
    return run;
  }

  whenDone(id: string): Promise<void> {
    return this.tasks.get(id) ?? Promise.resolve();
  }

  get(id: string): SelfTestRun | null {
    return this.runs.get(id) ?? null;
  }

  latestFinished(): SelfTestRun | null {
    let latest: SelfTestRun | null = null;
    for (const run of this.runs.values()) {
      if (run.status === 'running' || !run.finishedAt) continue;
      if (!latest || run.finishedAt >= (latest.finishedAt ?? '')) latest = run;
    }
    return latest;
  }

  private trim(): void {
    const finished = [...this.runs.values()]
      .filter((r) => r.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (finished.length > KEEP_RUNS) {
      const old = finished.shift();
      if (old) {
        this.runs.delete(old.id);
        this.tasks.delete(old.id);
      }
    }
  }

  async reapOrphans(maxAgeMs = REAPER_MAX_AGE_MS): Promise<string[]> {
    const cluster = this.factory.create();
    const reaped: string[] = [];
    const now = Date.now();
    for (const ns of await cluster.listSelfTestNamespaces()) {
      if (now - ns.createdAt < maxAgeMs) continue;
      try {
        await cluster.deleteNamespace(ns.name);
        reaped.push(ns.name);
      } catch (error) {
        this.logger.warn(`could not reap self-test namespace ${ns.name}: ${errorMessage(error)}`);
      }
    }
    if (reaped.length > 0)
      this.logger.warn(`reaped orphaned self-test namespaces: ${reaped.join(', ')}`);
    return reaped;
  }

  private async execute(run: SelfTestRun, cluster: SelfTestCluster): Promise<void> {
    const suffix = crypto.randomBytes(3).toString('hex');
    const nsA = `orchard-selftest-${suffix}-a`;
    const nsB = `orchard-selftest-${suffix}-b`;
    const labels = { [SELFTEST_LABEL]: run.id };
    const created: string[] = [];
    try {
      run.phase = 'reaping stale namespaces';
      await this.reapOrphans().catch((error) =>
        run.notes.push(`could not reap stale namespaces: ${errorMessage(error)}`)
      );

      run.phase = 'creating namespaces';
      for (const name of [nsA, nsB]) {
        created.push(name);
        await cluster.createTenantNamespace(name, labels);
      }
      const shape = await cluster.namespaceShape(nsA);
      run.checks.push(this.shapeCheck(shape));

      run.phase = 'starting listeners';
      await cluster.createPod(nsA, { name: 'listener', role: 'listener' });
      await cluster.createPod(nsB, { name: 'listener', role: 'listener' });
      const [listenerA, listenerB] = await Promise.all([
        this.waitFor(cluster, nsA, 'listener', 'running', this.timeouts.listenerMs),
        this.waitFor(cluster, nsB, 'listener', 'running', this.timeouts.listenerMs)
      ]);
      run.notes.push(...this.podNotes('listener (namespace A)', listenerA));
      run.notes.push(...this.podNotes('listener (namespace B)', listenerB));

      if (!listenerA.ip || !listenerB.ip) {
        run.checks.push(...checksFromResults(this.unreachableControls()));
        run.error = 'A listener pod never got an address; the probe could not run.';
        run.status = 'done';
        return;
      }

      run.phase = 'discovering targets';
      const topology = await cluster.discover(listenerA.ip, listenerB.ip);
      const targets = buildTargets(topology);
      const controlB: ProbeTarget = {
        id: 't900',
        group: 'control',
        kind: 'tcp',
        label: 'listener in the second namespace answers from inside it',
        host: listenerB.ip,
        port: LISTENER_PORT,
        expect: 'open'
      };

      run.phase = 'probing';
      await cluster.createPod(nsA, {
        name: 'probe',
        role: 'probe',
        env: { PROBE_TARGETS: probeInput(targets) }
      });
      await cluster.createPod(nsB, {
        name: 'probe',
        role: 'probe',
        env: { PROBE_TARGETS: probeInput([controlB]) }
      });
      const [probeA, probeB] = await Promise.all([
        this.waitFor(cluster, nsA, 'probe', 'finished', this.timeouts.probeMs),
        this.waitFor(cluster, nsB, 'probe', 'finished', this.timeouts.probeMs)
      ]);
      run.notes.push(...this.podNotes('probe (namespace A)', probeA));
      run.notes.push(...this.podNotes('probe (namespace B)', probeB));

      const logA = await this.readLog(cluster, nsA, probeA, run);
      const logB = await this.readLog(cluster, nsB, probeB, run);
      const parsedA = logA === null ? null : parseProbeLog(logA);
      const parsedB = logB === null ? null : parseProbeLog(logB);
      if (parsedA && !parsedA.done)
        run.notes.push('The probe in namespace A did not report completion.');

      const extra = new Map<string, Outcome>();
      const fromB = parsedB?.outcomes.get('t900');
      if (fromB) extra.set('t900', fromB);
      run.targets = resolveTargets([...targets, controlB], parsedA, extra);
      run.checks.push(...checksFromResults(run.targets));
      run.status = 'done';
    } finally {
      run.phase = 'cleaning up';
      run.leftovers = await this.cleanup(cluster, created);
      if (run.leftovers.length > 0) {
        run.notes.push(
          `Cleanup incomplete: ${run.leftovers.join(', ')} still exist. The reaper deletes them after ${Math.round(REAPER_MAX_AGE_MS / 60000)} minutes.`
        );
        this.logger.error(
          `self-test ${run.id} left namespaces behind: ${run.leftovers.join(', ')}`
        );
      }
      run.phase = 'finished';
    }
  }

  private unreachableControls(): TargetResult[] {
    return [
      {
        id: 't0',
        group: 'control',
        label: 'listener pod running',
        host: '',
        port: LISTENER_PORT,
        expect: 'open',
        outcome: 'missing',
        verdict: 'control-failed'
      }
    ];
  }

  private shapeCheck(shape: NamespaceShape): DoctorCheck {
    const id = 'selftest-namespace-shape';
    const title = 'Temporary tenant namespace was created like a real one';
    const problems: string[] = [];
    if (!shape.managed) problems.push('not labelled orchard.my/managed');
    if (!shape.denyPolicy) problems.push('no default-deny-all NetworkPolicy');
    if (!shape.quota) problems.push('no ResourceQuota');
    if (shape.podSecurity !== 'baseline' && shape.podSecurity !== 'restricted') {
      problems.push('no Pod Security enforce label');
    }
    if (problems.length > 0) {
      return check(
        id,
        title,
        'fail',
        `The server's own namespace creation path produced a namespace that is ${problems.join(', ')}.`,
        'Check server logs for namespace creation failures and the quota and policy RBAC of the server.'
      );
    }
    return check(
      id,
      title,
      'pass',
      'Labelled managed, with default-deny-all, a ResourceQuota and Pod Security enforcement.'
    );
  }

  private podNotes(label: string, state: PodState): string[] {
    return state.detail ? [`${label}: ${state.phase}. ${state.detail}`] : [];
  }

  private async readLog(
    cluster: SelfTestCluster,
    namespace: string,
    state: PodState,
    run: SelfTestRun
  ): Promise<string | null> {
    if (state.phase !== 'Succeeded' && state.phase !== 'Failed') return null;
    try {
      return await cluster.podLog(namespace, 'probe');
    } catch (error) {
      run.notes.push(`could not read the probe log: ${errorMessage(error)}`);
      return null;
    }
  }

  private async waitFor(
    cluster: SelfTestCluster,
    namespace: string,
    name: string,
    mode: 'running' | 'finished',
    timeoutMs: number
  ): Promise<PodState> {
    const deadline = Date.now() + timeoutMs;
    let last: PodState = { phase: 'Unknown', ip: null, detail: 'pod state never read' };
    while (Date.now() < deadline) {
      try {
        last = await cluster.podState(namespace, name);
      } catch (error) {
        last = { phase: 'Unknown', ip: null, detail: errorMessage(error) };
      }
      if (mode === 'running' && last.phase === 'Running' && last.ip) return last;
      if (last.phase === 'Succeeded' || last.phase === 'Failed') return last;
      await sleep(this.timeouts.pollMs);
    }
    return { ...last, detail: `${last.detail} (timed out waiting)`.trim() };
  }

  private async cleanup(cluster: SelfTestCluster, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    await Promise.allSettled(names.map((name) => cluster.deleteNamespace(name)));
    const deadline = Date.now() + this.timeouts.deleteMs;
    let remaining = names;
    while (remaining.length > 0 && Date.now() < deadline) {
      const stillThere: string[] = [];
      for (const name of remaining) {
        try {
          if (await cluster.namespaceExists(name)) stillThere.push(name);
        } catch {
          stillThere.push(name);
        }
      }
      remaining = stillThere;
      if (remaining.length === 0) break;
      await Promise.allSettled(remaining.map((name) => cluster.deleteNamespace(name)));
      await sleep(this.timeouts.pollMs);
    }
    return remaining;
  }
}
