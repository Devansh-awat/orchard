import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from './kubernetes.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrgEventsService } from '../events/org-events.service';

const ORCHARD_SELECTOR = 'app.kubernetes.io/managed-by=orchard';
const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const EMIT_COALESCE_MS = 750;

interface Ctx {
  deploymentId: string;
  orgId: string;
  projectId: string;
}

@Injectable()
export class K8sPodInformerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(K8sPodInformerService.name);
  private informer?: k8s.Informer<k8s.V1Pod> & k8s.ObjectCache<k8s.V1Pod>;
  private backoffMs = 1000;
  private stopped = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();
  private readonly lastEmit = new Map<string, number>();

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
  ) {}

  async onModuleInit() {
    const kc = this.kubernetes.kc;
    if (!kc) {
      this.logger.warn('No kubeconfig; pod informer disabled');
      return;
    }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const listFn = () =>
      coreApi.listPodForAllNamespaces(
        undefined,
        undefined,
        undefined,
        undefined,
        ORCHARD_SELECTOR,
      );

    this.informer = k8s.makeInformer(kc, '/api/v1/pods', listFn, ORCHARD_SELECTOR);
    this.informer.on('add', (pod) => this.onPodEvent(pod));
    this.informer.on('update', (pod) => this.onPodEvent(pod));
    this.informer.on('delete', (pod) => this.onPodEvent(pod));
    this.informer.on('connect', () => {
      this.backoffMs = 1000;
    });
    this.informer.on('error', (err) => {
      this.logger.warn(
        `pod informer error: ${(err as Error)?.message ?? err}; restarting in ${this.backoffMs}ms`,
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
    } catch {}
  }

  private async start() {
    if (this.stopped || !this.informer) return;
    try {
      await this.informer.start();
      this.logger.log('pod informer started');
    } catch (err) {
      this.logger.warn(`pod informer start failed: ${(err as Error)?.message ?? err}`);
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

  private async onPodEvent(pod: k8s.V1Pod) {
    const ns = pod.metadata?.namespace;
    const depName = pod.metadata?.labels?.['app.kubernetes.io/name'];
    if (!ns || !depName) return;
    const ctx = await this.resolveCtx(ns, depName);
    if (!ctx) return;

    const now = Date.now();
    const last = this.lastEmit.get(ctx.deploymentId) ?? 0;
    if (now - last < EMIT_COALESCE_MS) return;
    this.lastEmit.set(ctx.deploymentId, now);

    this.orgEvents.emitLocal({
      organizationId: ctx.orgId,
      type: 'pod.changed',
      id: ctx.deploymentId,
      projectId: ctx.projectId,
    });
  }

  private async resolveCtx(ns: string, depName: string): Promise<Ctx | null> {
    const key = `${ns}/${depName}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    let ctx: Ctx | null = null;
    try {
      const dep = await this.prisma.deployment.findFirst({
        where: { namespace: ns, name: depName },
        select: {
          id: true,
          projectId: true,
          project: { select: { organizationId: true } },
        },
      });
      if (dep) {
        ctx = { deploymentId: dep.id, orgId: dep.project.organizationId, projectId: dep.projectId };
      }
    } catch (err) {
      this.logger.warn(`resolveCtx(${key}) failed: ${(err as Error)?.message ?? err}`);
      return null;
    }

    this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return ctx;
  }
}
