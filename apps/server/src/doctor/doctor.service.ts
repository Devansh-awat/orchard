import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { getClientIp } from '../auth/client-ip';
import { signupMode } from '../auth/signup-mode';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { KubeClusterReader, type ClusterReader } from './cluster-reader';
import {
  PRIORITY_CLASS_NAME,
  evaluateAll,
  type DoctorInputs,
  type ProbeFact,
  type RequestFact
} from './doctor.checks';
import {
  errorMessage,
  fact,
  summarize,
  type DoctorCheck,
  type DoctorSummary,
  type Fact
} from './doctor.types';
import { SelfTestService, type SelfTestRun } from './selftest.service';

export interface DoctorReport {
  generatedAt: string;
  summary: DoctorSummary;
  checks: DoctorCheck[];
  selftest: {
    id: string;
    finishedAt: string | null;
    summary: DoctorSummary;
    checks: DoctorCheck[];
  } | null;
}

const MISSING_CLUSTER = 'Kubernetes API not available (no kubeconfig loaded)';

const METRICS_DEFAULT = 'http://victoriametrics.orchard-metrics.svc.cluster.local:8428';
const LOGS_DEFAULT = 'http://victorialogs.orchard-metrics.svc.cluster.local:9428';

export async function httpProbe(url: string, fetcher: typeof fetch = fetch): Promise<ProbeFact> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return { ok: res.status < 500, detail: `HTTP ${res.status} from ${new URL(url).host}` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

export function requestFact(
  req: Pick<Request, 'headers' | 'socket' | 'ip'> | null
): RequestFact | null {
  if (!req) return null;
  const forwarded = req.headers?.['x-forwarded-for'];
  return {
    socketAddress: req.socket?.remoteAddress ?? null,
    forwardedFor: (Array.isArray(forwarded) ? forwarded.join(',') : forwarded) || null,
    resolved: getClientIp(req as Request)
  };
}

@Injectable()
export class DoctorService {
  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly settings: InstanceSettingsService,
    private readonly selftest: SelfTestService
  ) {}

  protected reader(): ClusterReader | null {
    const kc = this.kubernetes.kc;
    return kc ? new KubeClusterReader(kc) : null;
  }

  protected fetcher: typeof fetch = (input, init) => fetch(input, init);

  async gather(
    req: Pick<Request, 'headers' | 'socket' | 'ip'> | null,
    env: Record<string, string | undefined> = process.env
  ): Promise<DoctorInputs> {
    const reader = this.reader();
    const cluster = <T>(read: (r: ClusterReader) => Promise<T>): Promise<Fact<T>> =>
      reader ? fact(() => read(reader)) : Promise.resolve({ ok: false, error: MISSING_CLUSTER });
    const tenantClass = (env.TENANT_RUNTIME_CLASS || '').trim();
    const builderClass = (env.BUILDER_RUNTIME_CLASS || '').trim();
    const issuer = (env.CERT_CLUSTER_ISSUER || '').trim() || 'letsencrypt-prod';
    const metricsUrl = (env.VICTORIAMETRICS_URL || METRICS_DEFAULT).replace(/\/$/, '');
    const logsUrl = (env.VICTORIALOGS_URL || LOGS_DEFAULT).replace(/\/$/, '');

    const [
      apiGroups,
      daemonSets,
      nodes,
      namespaces,
      denyPolicies,
      quotas,
      tenantRuntimeClass,
      builderRuntimeClass,
      admission,
      priorityClass,
      clusterIssuer,
      settings,
      metrics,
      logs
    ] = await Promise.all([
      cluster((r) => r.apiGroups()),
      cluster((r) => r.daemonSets()),
      cluster((r) => r.nodes()),
      cluster((r) => r.managedNamespaces()),
      cluster((r) => r.denyPolicyNamespaces()),
      cluster((r) => r.quotas()),
      tenantClass ? cluster((r) => r.runtimeClassExists(tenantClass)) : Promise.resolve(null),
      builderClass ? cluster((r) => r.runtimeClassExists(builderClass)) : Promise.resolve(null),
      cluster((r) => r.admission()),
      cluster((r) => r.priorityClassExists(PRIORITY_CLASS_NAME)),
      cluster((r) => r.clusterIssuer(issuer)),
      fact(async () => ({
        signupMode: signupMode(),
        customDomainVerification: await this.settings.isCustomDomainVerificationRequired()
      })),
      fact(() => httpProbe(`${metricsUrl}/health`, this.fetcher)),
      fact(() => httpProbe(`${logsUrl}/health`, this.fetcher))
    ]);

    return {
      env,
      request: requestFact(req),
      apiGroups,
      daemonSets,
      nodes,
      namespaces,
      denyPolicies,
      quotas,
      tenantRuntimeClass,
      builderRuntimeClass,
      admission,
      priorityClass,
      issuer: clusterIssuer,
      settings,
      metrics,
      logs
    };
  }

  async report(req: Pick<Request, 'headers' | 'socket' | 'ip'> | null): Promise<DoctorReport> {
    const checks = evaluateAll(await this.gather(req));
    return {
      generatedAt: new Date().toISOString(),
      summary: summarize(checks),
      checks,
      selftest: this.lastSelfTest()
    };
  }

  private lastSelfTest(): DoctorReport['selftest'] {
    const run: SelfTestRun | null = this.selftest.latestFinished();
    if (!run) return null;
    return {
      id: run.id,
      finishedAt: run.finishedAt,
      summary: run.summary,
      checks: run.checks
    };
  }
}
