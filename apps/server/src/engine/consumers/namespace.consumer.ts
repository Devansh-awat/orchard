import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { EnvironmentsService } from '../../projects/environments.service';
import { ProjectsService } from '../../projects/projects.service';
import { EngineEventType, EngineObjectKey } from '../core/informer';
import { K8S_DELETED_REASON } from './workload.consumer';

const SETTLE_GRACE_MS = 5 * 60 * 1000;
const CONFIRM_AFTER_MS = 90 * 1000;
const MAX_MISSING_PER_PASS = 3;

type NamespaceState = 'present' | 'absent' | 'unknown';

interface PendingRemoval {
  firstAbsentAt: number;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class NamespaceConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(NamespaceConsumer.name);

  private readonly pending = new Map<string, PendingRemoval>();

  protected confirmAfterMs = CONFIRM_AFTER_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly moduleRef: ModuleRef
  ) {}

  onModuleDestroy() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async onEvent(type: EngineEventType, ns: k8s.V1Namespace): Promise<void> {
    const name = ns.metadata?.name;
    if (!name) return;
    if (type !== 'delete') {
      this.clearPending(name);
      return;
    }
    await this.handleGone(name, 'watch');
  }

  async pruneMissing(seen: EngineObjectKey[]): Promise<void> {
    if (seen.length === 0) {
      this.logger.warn('skipping namespace prune: the list pass saw no namespaces');
      return;
    }
    if (seen.some((key) => key.refs === null)) {
      this.logger.warn('skipping namespace prune: some namespaces could not be resolved');
      return;
    }
    const live = new Set(seen.map((key) => key.name));
    for (const name of live) this.clearPending(name);

    const cutoff = this.graceCutoff();
    const [projects, environments] = await Promise.all([
      this.prisma.project.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { namespace: true }
      }),
      this.prisma.environment.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { namespace: true }
      })
    ]);
    const owned = new Set([
      ...projects.map((p) => p.namespace),
      ...environments.map((e) => e.namespace)
    ]);
    const missing = [...owned].filter((namespace) => !live.has(namespace));
    if (missing.length === 0) return;
    if (missing.length > MAX_MISSING_PER_PASS) {
      this.logger.error(
        `${missing.length} Orchard namespaces are absent from the cluster at once (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}). That is not what a manual delete looks like, so nothing is removed. If these were really deleted, remove the projects or environments from Orchard by hand.`
      );
      return;
    }
    for (const namespace of missing) {
      await this.handleGone(namespace, 'list');
    }
  }

  private async handleGone(namespace: string, source: 'watch' | 'list' | 'recheck'): Promise<void> {
    const owner = await this.ownerOf(namespace);
    if (!owner) {
      this.clearPending(namespace);
      return;
    }

    const state = await this.liveState(namespace);
    if (state === 'present') {
      if (this.pending.has(namespace)) {
        this.logger.warn(
          `namespace ${namespace} looked deleted (${source}) but the apiserver still has it; false alarm, nothing removed`
        );
      }
      this.clearPending(namespace);
      return;
    }
    if (state === 'unknown') {
      this.logger.warn(
        `namespace ${namespace} looks deleted (${source}) but the apiserver could not confirm it; leaving ${owner.kind} ${owner.id} alone until it can`
      );
      return;
    }

    const existing = this.pending.get(namespace);
    const now = Date.now();
    if (!existing) {
      const timer = setTimeout(() => {
        void this.handleGone(namespace, 'recheck').catch((err) =>
          this.logger.warn(`recheck of ${namespace} failed: ${(err as Error)?.message ?? err}`)
        );
      }, this.confirmAfterMs + 1000);
      timer.unref?.();
      this.pending.set(namespace, { firstAbsentAt: now, timer });
      this.logger.warn(
        `namespace ${namespace} is gone from the cluster (${source}); ${owner.kind} ${owner.id} (${owner.name}) will be removed if it is still gone in ${Math.round(this.confirmAfterMs / 1000)}s`
      );
      return;
    }
    if (now - existing.firstAbsentAt < this.confirmAfterMs) return;

    this.clearPending(namespace);
    const cause = {
      reason: K8S_DELETED_REASON,
      source: `mirror.${source}`,
      namespace,
      firstAbsentAt: new Date(existing.firstAbsentAt).toISOString(),
      confirmedAbsentAt: new Date(now).toISOString()
    };
    if (owner.kind === 'project') {
      this.logger.warn(
        `namespace ${namespace} confirmed deleted in the cluster; removing project ${owner.id} (${owner.name})`
      );
      const projects = this.moduleRef.get(ProjectsService, { strict: false });
      await projects.deleteProjectFromCluster(owner.id, cause);
      return;
    }
    this.logger.warn(
      `namespace ${namespace} confirmed deleted in the cluster; removing environment ${owner.id} (${owner.name})`
    );
    const environments = this.moduleRef.get(EnvironmentsService, { strict: false });
    await environments.deleteEnvironmentFromCluster(owner.id, cause);
  }

  private async ownerOf(
    namespace: string
  ): Promise<{ kind: 'project' | 'environment'; id: string; name: string } | null> {
    const cutoff = this.graceCutoff();
    const project = await this.prisma.project.findFirst({
      where: { namespace },
      select: { id: true, name: true, createdAt: true }
    });
    if (project) {
      if (project.createdAt > cutoff) {
        this.logger.warn(
          `namespace ${namespace} is gone but project ${project.id} is younger than the settle window; leaving it`
        );
        return null;
      }
      return { kind: 'project', id: project.id, name: project.name };
    }
    const environment = await this.prisma.environment.findUnique({
      where: { namespace },
      select: { id: true, name: true, createdAt: true }
    });
    if (!environment) return null;
    if (environment.createdAt > cutoff) {
      this.logger.warn(
        `namespace ${namespace} is gone but environment ${environment.id} is younger than the settle window; leaving it`
      );
      return null;
    }
    return { kind: 'environment', id: environment.id, name: environment.name };
  }

  protected async liveState(namespace: string): Promise<NamespaceState> {
    try {
      this.kubernetes.ensureKubeConfig();
      const { body } = await this.kubernetes
        .kc!.makeApiClient(k8s.CoreV1Api)
        .readNamespace(namespace);
      return body?.metadata?.name === namespace ? 'present' : 'unknown';
    } catch (err: any) {
      const code = err?.response?.statusCode ?? err?.statusCode;
      if (code === 404) return 'absent';
      this.logger.warn(
        `could not read namespace ${namespace} from the apiserver (${code ?? 'no status'}): ${err?.message ?? err}`
      );
      return 'unknown';
    }
  }

  private clearPending(namespace: string) {
    const p = this.pending.get(namespace);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(namespace);
  }

  private graceCutoff(): Date {
    return new Date(Date.now() - SETTLE_GRACE_MS);
  }
}
