import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { AuditService } from '../../audit/audit.service';
import { EngineEventType, EngineObjectKey, EngineRefs } from '../core/informer';
import { K8S_DELETED_REASON } from './workload.consumer';

const PRUNE_GRACE_MS = 2 * 60 * 1000;

interface ServiceRow {
  id: string;
  name: string;
  deploymentId: string;
  port: number;
  targetPort: number;
  protocol: string;
  externalIp: string | null;
  nodePort: number | null;
  updatedAt: Date;
  ports: {
    id: string;
    name: string | null;
    port: number;
    targetPort: number;
    protocol: string;
    nodePort: number | null;
    publicEnabled: boolean;
    publicPort: number | null;
  }[];
  deployment: {
    namespace: string;
    buildStatus: string | null;
    projectId: string;
    project: { organizationId: string };
  };
}

const SELECT = {
  id: true,
  name: true,
  deploymentId: true,
  port: true,
  targetPort: true,
  protocol: true,
  externalIp: true,
  nodePort: true,
  updatedAt: true,
  ports: {
    select: {
      id: true,
      name: true,
      port: true,
      targetPort: true,
      protocol: true,
      nodePort: true,
      publicEnabled: true,
      publicPort: true
    }
  },
  deployment: {
    select: {
      namespace: true,
      buildStatus: true,
      projectId: true,
      project: { select: { organizationId: true } }
    }
  }
} as const;

interface ObservedPort {
  name: string | null;
  port: number;
  targetPort: number;
  protocol: string;
  nodePort: number | null;
}

function observedPorts(svc: k8s.V1Service): ObservedPort[] | null {
  const ports = svc.spec?.ports ?? [];
  const out: ObservedPort[] = [];
  for (const p of ports) {
    if (typeof p.port !== 'number') return null;
    const target = p.targetPort ?? p.port;
    if (typeof target !== 'number') return null;
    out.push({
      name: p.name ?? null,
      port: p.port,
      targetPort: target,
      protocol: p.protocol ?? 'TCP',
      nodePort: typeof p.nodePort === 'number' ? p.nodePort : null
    });
  }
  return out;
}

@Injectable()
export class ServiceConsumer {
  private readonly logger = new Logger(ServiceConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly audit: AuditService
  ) {}

  async mapRefs(svc: k8s.V1Service): Promise<EngineRefs | null> {
    const row = await this.rowFor(svc.metadata?.namespace, svc.metadata?.name);
    if (!row) return null;
    return { deploymentId: row.deploymentId, projectId: row.deployment.projectId };
  }

  async onEvent(type: EngineEventType, svc: k8s.V1Service): Promise<void> {
    const row = await this.rowFor(svc.metadata?.namespace, svc.metadata?.name);
    if (!row) return;

    if (type === 'delete') {
      if (row.updatedAt > this.graceCutoff()) return;
      if (!(await this.workloadExists(row.deploymentId))) return;
      await this.prune(row, 'watch');
      return;
    }

    if (row.deployment.buildStatus === 'building') {
      throw new Error(`service adoption deferred for ${row.deploymentId}: build in flight`);
    }
    const pendingApply = await this.prisma.k8sApplyItem.count({
      where: { deploymentId: row.deploymentId, status: { in: ['pending', 'applying'] } }
    });
    if (pendingApply > 0) {
      throw new Error(
        `service adoption deferred for ${row.deploymentId}: ${pendingApply} apply item(s) queued`
      );
    }
    if (row.updatedAt > this.graceCutoff()) {
      throw new Error(`service adoption deferred for ${row.deploymentId}: row changed recently`);
    }

    const ports = observedPorts(svc);
    if (!ports || ports.length === 0) return;
    const lb = svc.status?.loadBalancer?.ingress?.[0];
    const externalIp = lb?.ip ?? lb?.hostname ?? null;
    const primary = ports[0];

    const serviceChanges: Record<string, unknown> = {};
    if (row.port !== primary.port) serviceChanges.port = primary.port;
    if (row.targetPort !== primary.targetPort) serviceChanges.targetPort = primary.targetPort;
    if (row.protocol !== primary.protocol) serviceChanges.protocol = primary.protocol;
    if ((row.nodePort ?? null) !== primary.nodePort) serviceChanges.nodePort = primary.nodePort;
    if (svc.spec?.type === 'LoadBalancer' && (row.externalIp ?? null) !== externalIp) {
      serviceChanges.externalIp = externalIp;
    }

    const key = (p: { port: number; protocol: string }) => `${p.protocol}/${p.port}`;
    const current = new Map(row.ports.map((p) => [key(p), p] as const));
    const seen = new Set<string>();
    const portWrites: Promise<unknown>[] = [];
    let portsChanged = false;
    for (const p of ports) {
      seen.add(key(p));
      const existing = current.get(key(p));
      if (!existing) {
        portsChanged = true;
        portWrites.push(
          this.prisma.servicePort.create({
            data: {
              serviceId: row.id,
              name: p.name,
              port: p.port,
              targetPort: p.targetPort,
              protocol: p.protocol,
              nodePort: p.nodePort
            }
          })
        );
        continue;
      }
      if (
        existing.name !== p.name ||
        existing.targetPort !== p.targetPort ||
        (existing.nodePort ?? null) !== p.nodePort
      ) {
        portsChanged = true;
        portWrites.push(
          this.prisma.servicePort.update({
            where: { id: existing.id },
            data: { name: p.name, targetPort: p.targetPort, nodePort: p.nodePort }
          })
        );
      }
    }
    const gone = row.ports.filter((p) => !seen.has(key(p)));
    if (gone.length > 0) {
      portsChanged = true;
      portWrites.push(
        this.prisma.servicePort.deleteMany({ where: { id: { in: gone.map((p) => p.id) } } })
      );
    }

    if (Object.keys(serviceChanges).length === 0 && !portsChanged) return;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(serviceChanges).length > 0) {
        await tx.service.update({ where: { id: row.id }, data: serviceChanges });
      }
    });
    await Promise.all(portWrites);

    this.logger.log(
      `adopted external service spec for ${row.deployment.namespace}/${row.name}: ${[
        ...Object.entries(serviceChanges).map(([k, v]) => `${k}=${String(v)}`),
        portsChanged
          ? `ports=${ports.map((p) => `${p.port}:${p.targetPort}/${p.protocol}`).join(',')}`
          : null
      ]
        .filter(Boolean)
        .join(', ')}`
    );
    this.emit(row, { service: row.name, adopted: true });
  }

  async pruneStaleRows(seen: EngineObjectKey[]): Promise<void> {
    if (seen.length === 0) {
      this.logger.warn('skipping service prune: the list pass saw no services');
      return;
    }
    if (seen.some((key) => key.refs === null)) {
      this.logger.warn('skipping service prune: some services could not be resolved');
      return;
    }
    const live = new Set(seen.map((key) => `${key.namespace}/${key.name}`));
    const candidates = await this.prisma.service.findMany({
      where: { updatedAt: { lt: this.graceCutoff() } },
      select: SELECT
    });
    for (const row of candidates) {
      if (live.has(`${row.deployment.namespace}/${row.name}`)) continue;
      if (!(await this.workloadExists(row.deploymentId))) continue;
      await this.prune(row as ServiceRow, 'list');
    }
  }

  private async workloadExists(deploymentId: string): Promise<boolean> {
    const workload = await this.prisma.k8sWorkload.findUnique({
      where: { deploymentId },
      select: { deploymentId: true }
    });
    return workload !== null;
  }

  private async prune(row: ServiceRow, source: 'watch' | 'list'): Promise<void> {
    try {
      await this.prisma.service.delete({ where: { id: row.id } });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') return;
      throw error;
    }
    this.logger.warn(
      `pruned service row ${row.deployment.namespace}/${row.name}: object absent from the cluster`
    );
    void this.audit.log({
      action: 'service.deleted',
      organizationId: row.deployment.project.organizationId,
      projectId: row.deployment.projectId,
      deploymentId: row.deploymentId,
      targetType: 'service',
      targetId: row.id,
      targetLabel: row.name,
      metadata: {
        reason: K8S_DELETED_REASON,
        source: `mirror.${source}`,
        namespace: row.deployment.namespace,
        ports: row.ports.map((p) => `${p.port}:${p.targetPort}/${p.protocol}`)
      }
    });
    this.emit(row, { service: row.name, deleted: true });
  }

  private emit(row: ServiceRow, payload: unknown) {
    this.orgEvents.emit({
      organizationId: row.deployment.project.organizationId,
      type: 'deployment.changed',
      id: row.deploymentId,
      projectId: row.deployment.projectId,
      payload
    });
  }

  private graceCutoff(): Date {
    return new Date(Date.now() - PRUNE_GRACE_MS);
  }

  private async rowFor(
    namespace: string | undefined,
    name: string | undefined
  ): Promise<ServiceRow | null> {
    if (!namespace || !name) return null;
    const row = await this.prisma.service.findFirst({
      where: { name, deployment: { namespace } },
      select: SELECT
    });
    return (row as ServiceRow | null) ?? null;
  }
}
