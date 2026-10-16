import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { EngineEventType, EngineObjectKey } from '../core/informer';
import { K8S_DELETED_REASON } from './workload.consumer';
import { LiveState, readLive } from './live-object';

const PRUNE_GRACE_MS = 2 * 60 * 1000;

interface OrphanRow {
  id: string;
  projectId: string;
  deploymentId: string | null;
  namespace: string;
  name: string;
  host: string;
  path: string;
  project: { organizationId: string };
}

const ORPHAN_SELECT = {
  id: true,
  projectId: true,
  deploymentId: true,
  namespace: true,
  name: true,
  host: true,
  path: true,
  project: { select: { organizationId: true } }
} as const;

@Injectable()
export class IngressConsumer {
  private readonly logger = new Logger(IngressConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly kubernetes: KubernetesService
  ) {}

  async onEvent(type: EngineEventType, ingress: k8s.V1Ingress): Promise<void> {
    if (type !== 'delete') return;
    const namespace = ingress.metadata?.namespace;
    const name = ingress.metadata?.name;
    if (!namespace || !name) return;
    const rows = await this.prisma.ingress.findMany({
      where: { namespace, name, updatedAt: { lt: this.graceCutoff() } },
      select: ORPHAN_SELECT
    });
    if (rows.length === 0) return;
    const state = await this.liveIngress(namespace, name);
    if (state === 'unknown') {
      throw new Error(
        `ingress ${namespace}/${name} removal deferred: the apiserver could not confirm the delete`
      );
    }
    if (state === 'present') {
      this.keptUnlabeled(namespace, name);
      return;
    }
    await this.removeRows(rows, 'watch');
  }

  async pruneStaleRows(seen: EngineObjectKey[]): Promise<void> {
    if (seen.length === 0) {
      this.logger.warn('skipping ingress prune: the list pass saw no ingresses');
      return;
    }
    const live = new Set(seen.map((key) => `${key.namespace}/${key.name}`));
    const candidates = await this.prisma.ingress.findMany({
      where: { updatedAt: { lt: this.graceCutoff() } },
      select: ORPHAN_SELECT
    });
    const orphans = new Map<string, OrphanRow[]>();
    for (const row of candidates) {
      const key = `${row.namespace}/${row.name}`;
      if (live.has(key)) continue;
      orphans.set(key, [...(orphans.get(key) ?? []), row]);
    }
    for (const rows of orphans.values()) {
      const { namespace, name } = rows[0];
      const state = await this.liveIngress(namespace, name);
      if (state === 'present') this.keptUnlabeled(namespace, name);
      if (state !== 'absent') continue;
      await this.removeRows(rows, 'list');
    }
  }

  protected async liveIngress(namespace: string, name: string): Promise<LiveState> {
    return readLive(this.kubernetes, this.logger, (kc) =>
      kc.makeApiClient(k8s.NetworkingV1Api).readNamespacedIngress(name, namespace)
    );
  }

  private keptUnlabeled(namespace: string, name: string): void {
    this.logger.warn(
      `ingress ${namespace}/${name} left the watch but still exists in the cluster; its leaf.dev/managed label was probably removed, so the orchard rows are kept`
    );
  }

  private graceCutoff(): Date {
    return new Date(Date.now() - PRUNE_GRACE_MS);
  }

  private async removeRows(rows: OrphanRow[], source: 'watch' | 'list'): Promise<void> {
    for (const row of rows) {
      try {
        await this.prisma.ingress.delete({ where: { id: row.id } });
      } catch (error) {
        if ((error as { code?: string })?.code === 'P2025') continue;
        throw error;
      }
      this.logger.warn(
        `pruned ingress row ${row.namespace}/${row.name} (${row.host}${row.path}): object absent from the cluster`
      );
      void this.audit.log({
        action: 'ingress.deleted',
        organizationId: row.project.organizationId,
        projectId: row.projectId,
        deploymentId: row.deploymentId ?? undefined,
        targetType: 'ingress',
        targetId: row.id,
        targetLabel: row.host + row.path,
        metadata: { reason: K8S_DELETED_REASON, source: `mirror.${source}` }
      });
    }
  }
}
