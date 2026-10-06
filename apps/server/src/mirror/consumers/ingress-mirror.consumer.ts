import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { MirrorEventType, MirrorObjectKey } from '../mirror-informer';

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
export class IngressMirrorConsumer {
  private readonly logger = new Logger(IngressMirrorConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async onEvent(type: MirrorEventType, ingress: k8s.V1Ingress): Promise<void> {
    if (type !== 'delete') return;
    const namespace = ingress.metadata?.namespace;
    const name = ingress.metadata?.name;
    if (!namespace || !name) return;
    const rows = await this.prisma.ingress.findMany({
      where: { namespace, name, updatedAt: { lt: this.graceCutoff() } },
      select: ORPHAN_SELECT
    });
    await this.removeRows(rows, 'watch');
  }

  async pruneStaleRows(seen: MirrorObjectKey[]): Promise<void> {
    if (seen.length === 0) {
      this.logger.warn('skipping ingress prune: the list pass saw no ingresses');
      return;
    }
    const live = new Set(seen.map((key) => `${key.namespace}/${key.name}`));
    const candidates = await this.prisma.ingress.findMany({
      where: { updatedAt: { lt: this.graceCutoff() } },
      select: ORPHAN_SELECT
    });
    const orphans = candidates.filter((row) => !live.has(`${row.namespace}/${row.name}`));
    await this.removeRows(orphans, 'list');
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
        metadata: { reason: 'resource eliminated in k8s', source: `mirror.${source}` }
      });
    }
  }
}
