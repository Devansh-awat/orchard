import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { OrgEventsService } from '../../events/org-events.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { EngineEventType, EngineObjectKey } from '../core/informer';
import { observedInMirror } from '../prisma-store';
import { K8S_DELETED_REASON } from './workload.consumer';
import { LiveState, readLive } from './live-object';
import {
  AdoptableIngressRow,
  IngressRowCreate,
  KnownService,
  observedIngressHost,
  planIngressAdoption
} from './ingress-adoption';

const PRUNE_GRACE_MS = 2 * 60 * 1000;
const CONFIRM_AFTER_MS = 90 * 1000;
const PATH_ADDED_REASON = 'path added in k8s';

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

type AdoptRow = AdoptableIngressRow & { updatedAt: Date; project: { organizationId: string } };

const ADOPT_SELECT = {
  id: true,
  projectId: true,
  deploymentId: true,
  serviceId: true,
  environmentId: true,
  namespace: true,
  name: true,
  host: true,
  path: true,
  pathType: true,
  tlsSecretName: true,
  tlsHosts: true,
  ingressClass: true,
  entrypoints: true,
  clusterIssuer: true,
  annotations: true,
  statusAddress: true,
  protectionMode: true,
  redirectTarget: true,
  servicePort: true,
  updatedAt: true,
  project: { select: { organizationId: true } }
} as const;

function describe(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([key, value]) => {
      if (value === Prisma.DbNull || value === null) return `${key}=null`;
      if (typeof value === 'object') return `${key}=${JSON.stringify(value)}`;
      return `${key}=${String(value)}`;
    })
    .join(', ');
}

@Injectable()
export class IngressConsumer {
  private readonly logger = new Logger(IngressConsumer.name);

  private readonly firstSeen = new Map<string, number>();

  private readonly noted = new Set<string>();

  protected confirmAfterMs = CONFIRM_AFTER_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly kubernetes: KubernetesService,
    private readonly orgEvents: OrgEventsService
  ) {}

  async onEvent(type: EngineEventType, ingress: k8s.V1Ingress): Promise<void> {
    if (type !== 'delete') {
      await this.adopt(ingress);
      return;
    }
    const namespace = ingress.metadata?.namespace;
    const name = ingress.metadata?.name;
    if (!namespace || !name) return;
    this.forget(namespace, name);
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
    if (orphans.size === 0) return;
    const observed = await this.observed(
      [...orphans.values()].map(([row]) => ({ namespace: row.namespace, name: row.name }))
    );
    for (const [key, rows] of orphans) {
      if (!observed.has(key)) continue;
      const { namespace, name } = rows[0];
      const state = await this.liveIngress(namespace, name);
      if (state === 'present') this.keptUnlabeled(namespace, name);
      if (state !== 'absent') continue;
      await this.removeRows(rows, 'list');
    }
  }

  private async adopt(ingress: k8s.V1Ingress): Promise<void> {
    const namespace = ingress.metadata?.namespace;
    const name = ingress.metadata?.name;
    if (!namespace || !name) return;
    const rows = (await this.prisma.ingress.findMany({
      where: { namespace, name },
      select: ADOPT_SELECT
    })) as AdoptRow[];
    if (rows.length === 0) {
      this.forget(namespace, name);
      return;
    }
    const services = await this.knownServices(namespace);
    const host = observedIngressHost(ingress);
    let hostAvailable = true;
    if (host && rows.some((row) => row.host !== host)) {
      const taken = await this.prisma.ingress.findFirst({
        where: { host, NOT: { projectId: rows[0].projectId } },
        select: { id: true }
      });
      hostAvailable = !taken;
    }
    const plan = planIngressAdoption(ingress, rows, services, hostAvailable);

    if (plan.updates.length > 0 || plan.removals.length > 0 || plan.creations.length > 0) {
      if (rows.some((row) => row.updatedAt > this.graceCutoff())) {
        throw new Error(`ingress adoption deferred for ${namespace}/${name}: row changed recently`);
      }
      const owners = new Set<string>();
      for (const row of rows) if (row.deploymentId) owners.add(row.deploymentId);
      for (const { data } of plan.updates) {
        if (typeof data.deploymentId === 'string') owners.add(data.deploymentId);
      }
      for (const { service } of plan.creations) owners.add(service.deploymentId);
      await this.assertQuiet(namespace, name, [...owners]);
    }

    const changed = new Map<string, { deploymentId: string | null; projectId: string }>();
    const touch = (deploymentId: string | null, projectId: string) =>
      changed.set(deploymentId ?? `project:${projectId}`, { deploymentId, projectId });

    for (const { row, data } of plan.updates) {
      try {
        await this.prisma.ingress.update({ where: { id: row.id }, data });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === 'P2025') continue;
        if (code === 'P2002') {
          this.logger.warn(
            `ingress ${namespace}/${name}: not adopting path ${String(data.path)}, another row already holds it`
          );
          continue;
        }
        throw error;
      }
      this.logger.log(
        `adopted external ingress spec for ${namespace}/${name}${row.path}: ${describe(data)}`
      );
      touch(row.deploymentId, row.projectId);
      if (typeof data.deploymentId === 'string') touch(data.deploymentId, row.projectId);
    }

    const prefix = `${namespace}/${name}|`;
    const wanted = new Set([
      ...plan.removals.map((row) => `${prefix}-${row.path}`),
      ...plan.creations.map((c) => `${prefix}+${c.path.path}`)
    ]);
    for (const key of this.firstSeen.keys()) {
      if (key.startsWith(prefix) && !wanted.has(key)) this.firstSeen.delete(key);
    }
    let waiting = 0;
    for (const row of plan.removals) {
      const key = `${prefix}-${row.path}`;
      if (!this.confirmed(key)) {
        waiting += 1;
        continue;
      }
      this.firstSeen.delete(key);
      if (await this.removePath(row as AdoptRow)) touch(row.deploymentId, row.projectId);
    }
    for (const creation of plan.creations) {
      const key = `${prefix}+${creation.path.path}`;
      if (!this.confirmed(key)) {
        waiting += 1;
        continue;
      }
      this.firstSeen.delete(key);
      if (await this.createPath(rows[0], creation)) {
        touch(creation.service.deploymentId, rows[0].projectId);
      }
    }

    for (const key of this.noted) {
      if (key.startsWith(prefix) && !plan.skipped.some((reason) => key === prefix + reason)) {
        this.noted.delete(key);
      }
    }
    for (const reason of plan.skipped) {
      if (this.noted.has(prefix + reason)) continue;
      this.noted.add(prefix + reason);
      this.logger.log(`ingress ${namespace}/${name} not fully adopted: ${reason}`);
    }

    const organizationId = rows[0].project.organizationId;
    for (const { deploymentId, projectId } of changed.values()) {
      this.orgEvents.emit(
        deploymentId
          ? {
              organizationId,
              type: 'deployment.changed',
              id: deploymentId,
              projectId,
              payload: { ingress: name, adopted: true }
            }
          : { organizationId, type: 'project.changed', id: projectId, projectId }
      );
    }

    if (waiting > 0) {
      throw new Error(
        `ingress ${namespace}/${name}: ${waiting} path change(s) wait for confirmation before rows are added or removed`
      );
    }
  }

  private confirmed(key: string): boolean {
    const now = Date.now();
    const first = this.firstSeen.get(key);
    if (first === undefined) {
      this.firstSeen.set(key, now);
      return false;
    }
    return now - first >= this.confirmAfterMs;
  }

  private forget(namespace: string, name: string): void {
    const prefix = `${namespace}/${name}|`;
    for (const key of this.firstSeen.keys()) if (key.startsWith(prefix)) this.firstSeen.delete(key);
    for (const key of this.noted) if (key.startsWith(prefix)) this.noted.delete(key);
  }

  private async assertQuiet(namespace: string, name: string, deploymentIds: string[]) {
    if (deploymentIds.length === 0) return;
    const building = await this.prisma.deployment.count({
      where: { id: { in: deploymentIds }, buildStatus: 'building' }
    });
    if (building > 0) {
      throw new Error(`ingress adoption deferred for ${namespace}/${name}: build in flight`);
    }
    const pendingApply = await this.prisma.k8sApplyItem.count({
      where: { deploymentId: { in: deploymentIds }, status: { in: ['pending', 'applying'] } }
    });
    if (pendingApply > 0) {
      throw new Error(
        `ingress adoption deferred for ${namespace}/${name}: ${pendingApply} apply item(s) queued`
      );
    }
  }

  private async knownServices(namespace: string): Promise<KnownService[]> {
    const services = await this.prisma.service.findMany({
      where: { deployment: { namespace } },
      select: {
        id: true,
        name: true,
        deploymentId: true,
        port: true,
        ports: { select: { port: true } }
      }
    });
    return services.map((s) => ({
      id: s.id,
      name: s.name,
      deploymentId: s.deploymentId,
      ports: [...new Set([s.port, ...s.ports.map((p) => p.port)])]
    }));
  }

  private async removePath(row: AdoptRow): Promise<boolean> {
    try {
      await this.prisma.ingress.delete({ where: { id: row.id } });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') return false;
      throw error;
    }
    this.logger.warn(
      `removed ingress row ${row.namespace}/${row.name} (${row.host}${row.path}): the path is gone from the object in the cluster`
    );
    void this.audit.log({
      action: 'ingress.deleted',
      organizationId: row.project.organizationId,
      projectId: row.projectId,
      deploymentId: row.deploymentId ?? undefined,
      targetType: 'ingress',
      targetId: row.id,
      targetLabel: row.host + row.path,
      metadata: {
        reason: K8S_DELETED_REASON,
        source: 'engine.net',
        namespace: row.namespace,
        ingress: row.name,
        path: row.path
      }
    });
    return true;
  }

  private async createPath(template: AdoptRow, creation: IngressRowCreate): Promise<boolean> {
    let created: { id: string };
    try {
      created = await this.prisma.ingress.create({
        data: creation.data as Prisma.IngressUncheckedCreateInput,
        select: { id: true }
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return false;
      throw error;
    }
    const host = String(creation.data.host);
    this.logger.log(
      `added ingress row ${template.namespace}/${template.name} (${host}${creation.path.path}) for a path added in the cluster`
    );
    void this.audit.log({
      action: 'ingress.created',
      organizationId: template.project.organizationId,
      projectId: template.projectId,
      deploymentId: creation.service.deploymentId,
      targetType: 'ingress',
      targetId: created.id,
      targetLabel: host + creation.path.path,
      metadata: {
        reason: PATH_ADDED_REASON,
        source: 'engine.net',
        namespace: template.namespace,
        ingress: template.name,
        path: creation.path.path,
        service: creation.service.name,
        servicePort: creation.path.servicePort
      }
    });
    return true;
  }

  protected async liveIngress(namespace: string, name: string): Promise<LiveState> {
    return readLive(this.kubernetes, this.logger, (kc) =>
      kc.makeApiClient(k8s.NetworkingV1Api).readNamespacedIngress(name, namespace)
    );
  }

  protected observed(keys: { namespace: string; name: string }[]): Promise<Set<string>> {
    return observedInMirror(this.prisma, 'Ingress', keys);
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
