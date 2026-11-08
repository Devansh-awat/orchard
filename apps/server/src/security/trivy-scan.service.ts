import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { RegistryCredentialsService } from '../projects/registry-credentials.service';
import { mergeRegistryAuths, registryAuth, type RegistryAuths } from '../docker/registry-pull-auth';
import {
  MAX_SCAN_ERROR,
  scanJobManifest,
  scanJobName,
  scanSecretManifest,
  scanTarget,
  type RegistryTopology
} from './trivy-job';
import {
  isStale,
  mapTrivyReport,
  scanFromRow,
  trivyErrorMessage,
  type StoredScan
} from './trivy-report';

export class ScanQueueFullError extends Error {}

const DEFAULT_IMAGE = 'ghcr.io/aquasecurity/trivy:0.76.1';

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

function hostsOf(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
  );
}

@Injectable()
export class TrivyScanService {
  private readonly logger = new Logger(TrivyScanService.name);
  private readonly serverUrl = (process.env.TRIVY_SERVER_URL || '').replace(/\/+$/, '');
  private readonly serverToken = process.env.TRIVY_SERVER_TOKEN || null;
  private readonly image = process.env.TRIVY_IMAGE || DEFAULT_IMAGE;
  private readonly namespace = process.env.TRIVY_SCAN_NAMESPACE || 'orchard-scans';
  private readonly internalUrl = (process.env.ORCHARD_INTERNAL_URL || '').replace(/\/+$/, '');
  private readonly timeoutSeconds = positiveInt(process.env.TRIVY_SCAN_TIMEOUT_SECONDS, 900);
  private readonly maxRunning = positiveInt(process.env.TRIVY_MAX_CONCURRENT_SCANS, 3);
  private readonly maxRunningPerOrg = positiveInt(process.env.TRIVY_MAX_SCANS_PER_ORG, 1);
  private readonly topology: RegistryTopology = {
    pullRegistry: process.env.DOCKER_REGISTRY_PULL || '',
    pushRegistry: process.env.DOCKER_REGISTRY_PUSH || '',
    httpHosts: hostsOf(process.env.REGISTRY_HTTP_HOSTS)
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly registryCredentials: RegistryCredentialsService
  ) {}

  get staleMs(): number {
    return (this.timeoutSeconds + 120) * 1000;
  }

  unavailableReason(): string | null {
    if (!this.serverUrl) return "TRIVY_SERVER_URL isn't set. Turn on trivy.enabled in the chart.";
    if (!this.internalUrl) return "ORCHARD_INTERNAL_URL isn't set, so scans can't report back.";
    if (!this.kubernetes.kc) return "Orchard can't reach Kubernetes to run scan jobs.";
    return null;
  }

  get configured(): boolean {
    return this.unavailableReason() === null;
  }

  private latestRow(image: string) {
    return this.prisma.imageScan.findFirst({
      where: { image, scanner: 'trivy' },
      orderBy: { createdAt: 'desc' }
    });
  }

  async latest(image: string): Promise<StoredScan> {
    return scanFromRow(await this.latestRow(image), this.staleMs, Date.now());
  }

  private ownRegistryAuths(): RegistryAuths {
    const username = process.env.HARBOR_USERNAME || '';
    const password = process.env.HARBOR_PASSWORD || '';
    if (!username || !password) return {};
    const auth = registryAuth(username, password);
    const out: RegistryAuths = {};
    for (const host of [this.topology.pullRegistry, this.topology.pushRegistry]) {
      if (!host) continue;
      out[host] = auth;
      if (this.topology.httpHosts.has(host) && !/:\d+$/.test(host)) out[`${host}:80`] = auth;
    }
    return out;
  }

  async start(
    image: string,
    opts: { deploymentId: string; userId: string | null }
  ): Promise<StoredScan> {
    const now = Date.now();
    const current = await this.latestRow(image);
    if (current && current.status === 'running' && !isStale(current, this.staleMs, now)) {
      return scanFromRow(current, this.staleMs, now);
    }
    const running = await this.prisma.imageScan.count({
      where: {
        scanner: 'trivy',
        status: 'running',
        createdAt: { gt: new Date(now - this.staleMs) }
      }
    });
    if (running >= this.maxRunning) {
      throw new ScanQueueFullError(
        `${running} scans are already running on this instance. Try again in a few minutes.`
      );
    }

    await this.assertOrgShare(opts.deploymentId);

    const token = randomBytes(32).toString('hex');
    const row = await this.prisma.imageScan.create({
      data: {
        image,
        scanner: 'trivy',
        status: 'running',
        tokenHash: hashToken(token),
        requestedBy: opts.userId,
        startedAt: new Date(now)
      }
    });
    const jobName = scanJobName(row.id);
    let created: k8s.V1Job | null = null;
    try {
      const auths = mergeRegistryAuths(
        this.ownRegistryAuths(),
        await this.registryCredentials.buildAuths(opts.deploymentId, {})
      );
      const job = scanJobManifest({
        scanId: row.id,
        namespace: this.namespace,
        trivyImage: this.image,
        serverUrl: this.serverUrl,
        resultUrl: `${this.internalUrl}/apiv1/internal/image-scans/${row.id}/result`,
        target: scanTarget(image, this.topology),
        timeoutSeconds: this.timeoutSeconds,
        withServerToken: Boolean(this.serverToken)
      });
      this.kubernetes.ensureKubeConfig();
      const kc = this.kubernetes.kc!;
      created = (await kc.makeApiClient(k8s.BatchV1Api).createNamespacedJob(this.namespace, job))
        .body;
      await kc
        .makeApiClient(k8s.CoreV1Api)
        .createNamespacedSecret(
          this.namespace,
          scanSecretManifest(created, { scanToken: token, serverToken: this.serverToken, auths })
        );
      const updated = await this.prisma.imageScan.update({
        where: { id: row.id },
        data: { jobName }
      });
      return scanFromRow(updated, this.staleMs, Date.now());
    } catch (err: any) {
      const detail = err?.body?.message || err?.message || 'unknown error';
      this.logger.warn(`image scan ${row.id} couldn't start: ${detail}`);
      if (created) await this.abandon(jobName);
      const failed = await this.prisma.imageScan.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          jobName,
          tokenHash: null,
          error: `Couldn't start the scan job in ${this.namespace}: ${detail}`.slice(0, 1000),
          finishedAt: new Date()
        }
      });
      return scanFromRow(failed, this.staleMs, Date.now());
    }
  }

  private async assertOrgShare(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { project: { select: { organizationId: true } } }
    });
    const organizationId = deployment?.project?.organizationId;
    if (!organizationId) return;
    const active = await this.prisma.imageScan.findMany({
      where: {
        scanner: 'trivy',
        status: 'running',
        requestedBy: { not: null },
        createdAt: { gt: new Date(Date.now() - this.staleMs) }
      },
      select: { requestedBy: true },
      take: 100
    });
    if (active.length === 0) return;
    const owners = [...new Set(active.map((r) => r.requestedBy as string))];
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, userId: { in: owners } },
      select: { userId: true }
    });
    const inOrg = new Set(members.map((m) => m.userId));
    const orgRunning = active.filter((r) => inOrg.has(r.requestedBy as string)).length;
    if (orgRunning >= Math.min(this.maxRunningPerOrg, this.maxRunning)) {
      throw new ScanQueueFullError(
        'Your organization already has the most scans it can run at once. Try again when one finishes.'
      );
    }
  }

  private async abandon(jobName: string): Promise<void> {
    try {
      await this.kubernetes
        .kc!.makeApiClient(k8s.BatchV1Api)
        .deleteNamespacedJob(
          jobName,
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          'Background'
        );
    } catch (err: any) {
      this.logger.warn(
        `couldn't remove scan job ${jobName}: ${err?.body?.message || err?.message}`
      );
    }
  }

  async assertAcceptingResult(id: string, token: string | undefined): Promise<void> {
    const row = await this.prisma.imageScan.findUnique({ where: { id } });
    if (!row || row.scanner !== 'trivy') throw new NotFoundException('Scan not found');
    if (row.status !== 'running' || !row.tokenHash || !token) {
      throw new ForbiddenException("This scan isn't accepting results");
    }
    if (!sameHash(hashToken(token), row.tokenHash)) {
      throw new ForbiddenException("This scan isn't accepting results");
    }
  }

  async complete(id: string, token: string | undefined, body: unknown): Promise<void> {
    await this.assertAcceptingResult(id, token);
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === 'string') {
      await this.prisma.imageScan.updateMany({
        where: { id, status: 'running' },
        data: {
          status: 'failed',
          tokenHash: null,
          error: trivyErrorMessage(error).slice(0, MAX_SCAN_ERROR),
          finishedAt: new Date()
        }
      });
      return;
    }
    const report = mapTrivyReport(body);
    await this.prisma.imageScan.updateMany({
      where: { id, status: 'running' },
      data: {
        status: 'done',
        tokenHash: null,
        digest: report.digest,
        report: report as object,
        finishedAt: new Date()
      }
    });
  }
}
