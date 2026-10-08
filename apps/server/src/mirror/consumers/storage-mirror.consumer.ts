import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { AuditService } from '../../audit/audit.service';
import { observePvc } from '../../kubernetes/pvc-status';
import { MirrorEventType, MirrorRefs } from '../mirror-informer';
import { K8S_DELETED_REASON } from './workload-mirror.consumer';

const MISSING_PHASE = 'Missing';

interface VolumeRow {
  id: string;
  name: string;
  deploymentId: string;
  observedCapacity: string | null;
  phase: string | null;
  resizeState: string | null;
  resizeMessage: string | null;
  deployment: { projectId: string; project: { organizationId: string } };
}

@Injectable()
export class StorageMirrorConsumer {
  private readonly logger = new Logger(StorageMirrorConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly audit: AuditService
  ) {}

  async mapRefs(pvc: k8s.V1PersistentVolumeClaim): Promise<MirrorRefs | null> {
    const rows = await this.volumeRows(pvc);
    if (rows.length === 0) return null;
    return { deploymentId: rows[0].deploymentId, projectId: rows[0].deployment.projectId };
  }

  async onEvent(type: MirrorEventType, pvc: k8s.V1PersistentVolumeClaim): Promise<void> {
    const rows = await this.volumeRows(pvc);
    if (rows.length === 0) return;

    const next =
      type === 'delete'
        ? { observedCapacity: null, phase: MISSING_PHASE, resizeState: null, resizeMessage: null }
        : (() => {
            const seen = observePvc(pvc);
            return {
              observedCapacity: seen.capacity,
              phase: seen.phase,
              resizeState: seen.resizeState,
              resizeMessage: seen.message
            };
          })();

    const touched = new Map<string, VolumeRow>();
    for (const row of rows) {
      const changed =
        row.observedCapacity !== next.observedCapacity ||
        row.phase !== next.phase ||
        row.resizeState !== next.resizeState ||
        row.resizeMessage !== next.resizeMessage;
      await this.prisma.deploymentVolume.update({
        where: { id: row.id },
        data: { ...next, observedAt: new Date() }
      });
      if (changed) touched.set(row.deploymentId, row);
    }

    for (const row of touched.values()) {
      if (type === 'delete') {
        void this.audit.log({
          action: 'deployment.volume.deleted',
          organizationId: row.deployment.project.organizationId,
          projectId: row.deployment.projectId,
          deploymentId: row.deploymentId,
          targetType: 'volume',
          targetId: row.id,
          targetLabel: pvc.metadata?.name ?? row.name,
          metadata: { reason: K8S_DELETED_REASON, namespace: pvc.metadata?.namespace ?? null }
        });
      }
      this.logger.log(
        `volume ${row.name} on ${row.deploymentId}: ${next.phase ?? 'unknown'} ${next.observedCapacity ?? ''}${next.resizeState ? ` (${next.resizeState})` : ''}`
      );
      this.orgEvents.emit({
        organizationId: row.deployment.project.organizationId,
        type: 'deployment.changed',
        id: row.deploymentId,
        projectId: row.deployment.projectId,
        payload: { volume: { name: row.name, ...next } }
      });
    }
  }

  private async volumeRows(pvc: k8s.V1PersistentVolumeClaim): Promise<VolumeRow[]> {
    const namespace = pvc.metadata?.namespace;
    const name = pvc.metadata?.name;
    if (!namespace || !name) return [];
    return this.prisma.deploymentVolume.findMany({
      where: {
        type: 'pvc',
        deployment: { namespace },
        OR: [{ pvcName: name }, { pvcName: null, name }]
      },
      select: {
        id: true,
        name: true,
        deploymentId: true,
        observedCapacity: true,
        phase: true,
        resizeState: true,
        resizeMessage: true,
        deployment: { select: { projectId: true, project: { select: { organizationId: true } } } }
      }
    });
  }
}
