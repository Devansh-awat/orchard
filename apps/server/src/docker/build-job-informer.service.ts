import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';

export type BuildJobPhase = 'pending' | 'running' | 'succeeded' | 'failed' | 'gone';

export interface BuildJobObservation {
  phase: BuildJobPhase;
  reason: string | null;
  image: string | null;
  deploymentId: string | null;
  at: number;
}

export interface BuildJobTerminalEvent extends BuildJobObservation {
  jobName: string;
}

const DEPLOYMENT_ID_LABEL = 'orchard.my/deployment-id';
const FULL_IMAGE_ANNOTATIONS = ['orchard.my/full-image', 'orchard.dev/full-image'];

export function buildJobTerminalOutcome(
  job: k8s.V1Job,
): { terminal: boolean; succeeded: boolean; reason: string | null } {
  const conditions = job.status?.conditions ?? [];
  const complete = conditions.find((c) => c.type === 'Complete' && c.status === 'True');
  if (complete) return { terminal: true, succeeded: true, reason: null };
  const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
  if (failed) return { terminal: true, succeeded: false, reason: failed.reason ?? 'Failed' };
  return { terminal: false, succeeded: false, reason: null };
}

export function observationFromJob(job: k8s.V1Job): BuildJobObservation {
  const outcome = buildJobTerminalOutcome(job);
  const annotations = job.metadata?.annotations ?? {};
  const image = FULL_IMAGE_ANNOTATIONS.map((k) => annotations[k]).find(Boolean) ?? null;

  let phase: BuildJobPhase;
  if (outcome.terminal) phase = outcome.succeeded ? 'succeeded' : 'failed';
  else if (job.status?.active) phase = 'running';
  else phase = 'pending';

  const deploymentId = job.metadata?.labels?.[DEPLOYMENT_ID_LABEL]
    ?? job.metadata?.labels?.['orchard.dev/deployment-id']
    ?? null;

  return { phase, reason: outcome.reason, image, deploymentId, at: Date.now() };
}

@Injectable()
export class BuildJobInformerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildJobInformerService.name);

  private readonly namespace = process.env.BUILDER_NAMESPACE || 'orchard-builders';

  private informer?: k8s.Informer<k8s.V1Job> & k8s.ObjectCache<k8s.V1Job>;

  private readonly latest = new Map<string, BuildJobObservation>();

  private readonly waiters = new Map<string, Set<(obs: BuildJobObservation) => void>>();

  private readonly terminalSubscribers = new Set<(event: BuildJobTerminalEvent) => void>();

  private connected = false;

  private backoffMs = 1000;

  private stopped = false;

  private restartTimer?: ReturnType<typeof setTimeout>;

  private kc: k8s.KubeConfig | null = null;

  async onModuleInit() {
    if (!process.env.KUBERNETES_SERVICE_HOST && !process.env.KUBECONFIG) {
      this.logger.log('No cluster config; build job informer disabled');
      return;
    }
    try {
      const kc = new k8s.KubeConfig();
      if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
      else kc.loadFromDefault();
      this.kc = kc;
    } catch (err) {
      this.logger.warn(`Could not load kubeconfig: ${(err as Error)?.message ?? err}`);
      return;
    }

    const batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    const listFn = () =>
      batchApi.listNamespacedJob(
        this.namespace,
        undefined, undefined, undefined, undefined,
        DEPLOYMENT_ID_LABEL,
      );

    this.informer = k8s.makeInformer(
      this.kc,
      `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
      listFn,
      DEPLOYMENT_ID_LABEL,
    );

    this.informer.on('add', (job) => this.record(job));
    this.informer.on('update', (job) => this.record(job));
    this.informer.on('delete', (job) => this.forget(job));
    this.informer.on('connect', () => {
      this.connected = true;
      this.backoffMs = 1000;
    });
    this.informer.on('error', (err) => {
      this.connected = false;
      this.logger.warn(
        `build job informer error: ${(err as Error)?.message ?? err}; restarting in ${this.backoffMs}ms`,
      );
      this.scheduleRestart();
    });

    await this.start();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    try {
      await this.informer?.stop();
    } catch { /* shutting down */ }
  }

  private async start() {
    if (this.stopped || !this.informer) return;
    try {
      await this.informer.start();
      this.connected = true;
      this.logger.log(`build job informer watching ${this.namespace}`);
    } catch (err) {
      this.connected = false;
      this.logger.warn(`build job informer start failed: ${(err as Error)?.message ?? err}`);
      this.scheduleRestart();
    }
  }

  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, delay);
  }

  private record(job: k8s.V1Job) {
    const name = job.metadata?.name;
    if (!name) return;
    const observation = observationFromJob(job);
    this.latest.set(name, observation);
    if (observation.phase === 'succeeded' || observation.phase === 'failed') {
      this.notify(name, observation);
    }
  }

  private forget(job: k8s.V1Job) {
    const name = job.metadata?.name;
    if (!name) return;
    const known = this.latest.get(name);
    if (known && (known.phase === 'succeeded' || known.phase === 'failed')) {
      this.notify(name, known);
      return;
    }
    const observation: BuildJobObservation = {
      phase: 'gone',
      reason: 'JobDeleted',
      image: known?.image ?? null,
      deploymentId: known?.deploymentId ?? observationFromJob(job).deploymentId,
      at: Date.now(),
    };
    this.latest.set(name, observation);
    this.notify(name, observation);
  }

  private notify(name: string, observation: BuildJobObservation) {
    for (const subscriber of this.terminalSubscribers) {
      try {
        subscriber({ ...observation, jobName: name });
      } catch { /* ignore */ }
    }

    const set = this.waiters.get(name);
    if (!set) return;
    this.waiters.delete(name);
    for (const resolve of set) {
      try {
        resolve(observation);
      } catch { /* ignore */ }
    }
  }

  onTerminal(handler: (event: BuildJobTerminalEvent) => void): () => void {
    this.terminalSubscribers.add(handler);
    return () => this.terminalSubscribers.delete(handler);
  }

  isHealthy(): boolean {
    return this.connected && !!this.informer;
  }

  get(jobName: string): BuildJobObservation | null {
    if (!this.isHealthy()) return null;
    const known = this.latest.get(jobName);
    if (known) return known;
    return { phase: 'gone', reason: 'NotFound', image: null, deploymentId: null, at: Date.now() };
  }

  waitForTerminal(jobName: string, timeoutMs: number): Promise<BuildJobObservation | null> {
    const known = this.latest.get(jobName);
    if (known && known.phase !== 'pending' && known.phase !== 'running') {
      return Promise.resolve(known);
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onEvent = (obs: BuildJobObservation) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.waiters.get(jobName)?.delete(onEvent);
        resolve(obs);
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters.get(jobName)?.delete(onEvent);
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      let set = this.waiters.get(jobName);
      if (!set) {
        set = new Set();
        this.waiters.set(jobName, set);
      }
      set.add(onEvent);
    });
  }

  release(jobName: string) {
    this.latest.delete(jobName);
    this.waiters.delete(jobName);
  }
}
