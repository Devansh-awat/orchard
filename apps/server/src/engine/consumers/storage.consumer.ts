import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { LiveState, readLive } from './live-object';
import { OrgEventsService } from '../../events/org-events.service';
import { AuditService } from '../../audit/audit.service';
import { observePvc } from '../../kubernetes/pvc-status';
import { parseMemory } from '../../kubernetes/quantity';
import { EngineEventType, EngineRefs } from '../core/informer';
import { K8S_DELETED_REASON } from './workload.consumer';

const MISSING_PHASE = 'Missing';
const DEFAULT_STORAGE_SIZE = '1Gi';
const STORAGE_SIZE_MAX_LENGTH = 20;

export function grownStorageSize(stored: string | null, requested: string | null): string | null {
  if (!requested || requested.length > STORAGE_SIZE_MAX_LENGTH) return null;
  const next = parseMemory(requested);
  if (next <= 0) return null;
  const current = parseMemory(stored ?? DEFAULT_STORAGE_SIZE);
  if (current <= 0) return null;
  return next > current ? requested : null;
}

interface VolumeRow {
  id: string;
  name: string;
  deploymentId: string;
  storageSize: string | null;
  observedCapacity: string | null;
  phase: string | null;
  resizeState: string | null;
  resizeMessage: string | null;
  deployment: { projectId: string; project: { organizationId: string } };
}

@Injectable()
export class StorageConsumer {
  private readonly logger = new Logger(StorageConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly audit: AuditService,
    private readonly kubernetes: KubernetesService
  ) {}

  protected livePvc(namespace: string, name: string): Promise<LiveState> {
    return readLive(this.kubernetes, this.logger, (kc) =>
      kc.makeApiClient(k8s.CoreV1Api).readNamespacedPersistentVolumeClaim(name, namespace)
    );
  }

  async mapRefs(pvc: k8s.V1PersistentVolumeClaim): Promise<EngineRefs | null> {
    const rows = await this.volumeRows(pvc);
    if (rows.length === 0) return null;
    return { deploymentId: rows[0].deploymentId, projectId: rows[0].deployment.projectId };
  }

  async onEvent(type: EngineEventType, pvc: k8s.V1PersistentVolumeClaim): Promise<void> {
    if (type === 'delete' && pvc.metadata?.namespace && pvc.metadata?.name) {
      const state = await this.livePvc(pvc.metadata.namespace, pvc.metadata.name);
      if (state === 'present') return;
      if (state === 'unknown') {
        throw new Error(
          `pvc ${pvc.metadata.namespace}/${pvc.metadata.name} looks deleted but the apiserver could not confirm it`
        );
      }
    }
    const rows = await this.volumeRows(pvc);
    if (rows.length === 0) return;

    const seen = type === 'delete' ? null : observePvc(pvc);
    const next = seen
      ? {
          observedCapacity: seen.capacity,
          phase: seen.phase,
          resizeState: seen.resizeState,
          resizeMessage: seen.message
        }
      : { observedCapacity: null, phase: MISSING_PHASE, resizeState: null, resizeMessage: null };

    const touched = new Map<string, VolumeRow>();
    for (const row of rows) {
      const grown = seen ? grownStorageSize(row.storageSize, seen.requested) : null;
      const changed =
        grown !== null ||
        row.observedCapacity !== next.observedCapacity ||
        row.phase !== next.phase ||
        row.resizeState !== next.resizeState ||
        row.resizeMessage !== next.resizeMessage;
      await this.prisma.deploymentVolume.update({
        where: { id: row.id },
        data: { ...next, ...(grown ? { storageSize: grown } : {}), observedAt: new Date() }
      });
      if (grown) {
        this.logger.log(
          `adopted external storage size for volume ${row.name} on ${row.deploymentId}: ${row.storageSize ?? DEFAULT_STORAGE_SIZE} -> ${grown}`
        );
      }
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
        storageSize: true,
        observedCapacity: true,
        phase: true,
        resizeState: true,
        resizeMessage: true,
        deployment: { select: { projectId: true, project: { select: { organizationId: true } } } }
      }
    });
  }
}
