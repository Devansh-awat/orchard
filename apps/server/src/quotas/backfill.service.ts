import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { RESOURCE_PRESETS, type ResourcePreset } from '../kubernetes/presets';

export interface BackfillRow {
  kind: 'deployment' | 'database';
  id: string;
  name: string;
  namespace: string;
  project: { id: string; name: string; slug: string } | null;
  organization: { id: string; name: string; slug: string } | null;
  pods: number;
  observed: { cpuMilli: number; memoryBytes: number } | null; // sum across pods
  recommendation: { cpuMilli: number; memoryBytes: number; presetId: string } | null;
}

// Snap an observed usage up to the smallest preset that fits,
// with a 1.5× headroom applied first. Floor: smallest preset.
function recommendFromUsage(observed: { cpuMilli: number; memoryBytes: number }): ResourcePreset {
  const targetCpu = Math.max(1, Math.round(observed.cpuMilli * 1.5));
  const targetMem = Math.max(1, Math.round(observed.memoryBytes * 1.5));
  for (const preset of RESOURCE_PRESETS) {
    if (preset.cpuMilli >= targetCpu && preset.memoryBytes >= targetMem) return preset;
  }
  return RESOURCE_PRESETS[RESOURCE_PRESETS.length - 1];
}

@Injectable()
export class QuotaBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: KubernetesService,
  ) {}

  // List every Deployment and Database that has no cpuRequestMilli set,
  // with live usage from metrics-server and a recommended preset.
  async listCandidates(): Promise<BackfillRow[]> {
    const [deployments, databases, metrics, labels] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { cpuRequestMilli: null },
        include: {
          project: {
            select: {
              id: true,
              name: true,
              slug: true,
              organization: { select: { id: true, name: true, slug: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.database.findMany({
        where: { cpuRequestMilli: null, mode: 'cnpg' },
        include: {
          project: {
            select: {
              id: true,
              name: true,
              slug: true,
              organization: { select: { id: true, name: true, slug: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.k8s.getAllPodMetrics(),
      this.k8s.getAllPodLabels(),
    ]);

    const rows: BackfillRow[] = [];

    for (const d of deployments) {
      // Find live pods by k8s label `app.kubernetes.io/name == deployment name` in its namespace.
      let sumCpu = 0;
      let sumMem = 0;
      let matched = 0;
      for (const [key, lbl] of labels) {
        if (!key.startsWith(`${d.namespace}/`)) continue;
        if (lbl['app.kubernetes.io/name'] !== d.name) continue;
        const m = metrics.get(key);
        if (!m) continue;
        sumCpu += m.cpuMilli;
        sumMem += m.memoryBytes;
        matched += 1;
      }
      const perReplica = matched > 0
        ? { cpuMilli: Math.round(sumCpu / matched), memoryBytes: Math.round(sumMem / matched) }
        : null;
      const rec = perReplica ? recommendFromUsage(perReplica) : null;
      rows.push({
        kind: 'deployment',
        id: d.id,
        name: d.name,
        namespace: d.namespace,
        project: d.project
          ? { id: d.project.id, name: d.project.name, slug: d.project.slug }
          : null,
        organization: d.project?.organization
          ? { id: d.project.organization.id, name: d.project.organization.name, slug: d.project.organization.slug }
          : null,
        pods: matched,
        observed: perReplica,
        recommendation: rec
          ? { cpuMilli: rec.cpuMilli, memoryBytes: rec.memoryBytes, presetId: rec.id }
          : null,
      });
    }

    for (const db of databases) {
      if (!db.namespace || !db.clusterName) continue;
      // CNPG pods are named `<clusterName>-<N>` in the same namespace.
      let sumCpu = 0;
      let sumMem = 0;
      let matched = 0;
      for (const [, m] of metrics) {
        if (m.namespace !== db.namespace) continue;
        if (!m.podName.startsWith(`${db.clusterName}-`)) continue;
        sumCpu += m.cpuMilli;
        sumMem += m.memoryBytes;
        matched += 1;
      }
      const observed = matched > 0
        ? { cpuMilli: Math.round(sumCpu / matched), memoryBytes: Math.round(sumMem / matched) }
        : null;
      const rec = observed ? recommendFromUsage(observed) : null;
      rows.push({
        kind: 'database',
        id: db.id,
        name: db.name,
        namespace: db.namespace,
        project: db.project
          ? { id: db.project.id, name: db.project.name, slug: db.project.slug }
          : null,
        organization: db.project?.organization
          ? { id: db.project.organization.id, name: db.project.organization.name, slug: db.project.organization.slug }
          : null,
        pods: matched,
        observed,
        recommendation: rec
          ? { cpuMilli: rec.cpuMilli, memoryBytes: rec.memoryBytes, presetId: rec.id }
          : null,
      });
    }

    return rows;
  }

  // Apply a chosen size to one target. Updates DB row + patches k8s.
  async apply(
    target: { kind: 'deployment' | 'database'; id: string },
    values: { cpuMilli: number; memoryBytes: number },
  ) {
    if (target.kind === 'deployment') {
      const d = await this.prisma.deployment.findUnique({ where: { id: target.id } });
      if (!d) throw new Error('Deployment not found');
      await this.k8s.updateDeploymentResources(d.namespace, d.name, values);
      await this.prisma.deployment.update({
        where: { id: target.id },
        data: {
          cpuRequestMilli: values.cpuMilli,
          memoryRequestBytes: BigInt(values.memoryBytes),
        },
      });
    } else {
      const db = await this.prisma.database.findUnique({ where: { id: target.id } });
      if (!db) throw new Error('Database not found');
      if (!db.namespace || !db.clusterName) throw new Error('Database not on CNPG');
      await this.k8s.updateCnpgClusterResources(db.namespace, db.clusterName, values);
      await this.prisma.database.update({
        where: { id: target.id },
        data: {
          cpuRequestMilli: values.cpuMilli,
          memoryRequestBytes: BigInt(values.memoryBytes),
        },
      });
    }
  }
}
