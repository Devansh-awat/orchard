import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RepoFilesService } from '../git/repo-files.service';
import { ResourceBindingsService } from '../projects/resource-bindings.service';
import type { FileReader } from '../github/framework-detect';
import {
  SCORE_FILES,
  bindingNameForResource,
  parseScore,
  summarize,
  type ScorePlan,
  type ScoreSummary
} from './score-parse';

export interface ScoreActor {
  clerkId: string;
  userId: string;
  userData?: {
    email?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    imageUrl?: string;
  };
  accessToken?: string | null;
}

export interface ScoreApplyResult extends ScoreSummary {
  applied: string[];
}

/**
 * `score.yaml` describes the workload; Orchard keeps owning the build through
 * orchard.json. Every apply is a reconcile: the file is read again at the ref
 * being built and the app is brought to it. A postgres resource is a managed
 * database on the project, bound to the app, so `${resources.db.*}` arrives
 * as a live reference and never as a copied password.
 */
@Injectable()
export class ScoreService {
  private readonly logger = new Logger(ScoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly repoFiles: RepoFilesService,
    private readonly bindings: ResourceBindingsService,
    private readonly moduleRef: ModuleRef
  ) {}

  async readPlan(reader: FileReader): Promise<{ file: string; plan: ScorePlan } | null> {
    for (const file of SCORE_FILES) {
      const plan = parseScore(await reader(file));
      if (plan) return { file, plan };
    }
    return null;
  }

  async summaryFor(reader: FileReader): Promise<ScoreSummary | null> {
    const found = await this.readPlan(reader);
    return found ? summarize(found.file, found.plan) : null;
  }

  async applyForDeployment(
    deploymentId: string,
    actor: ScoreActor
  ): Promise<ScoreApplyResult | null> {
    const reader = await this.repoFiles.readerForDeployment(deploymentId, {
      accessToken: actor.accessToken,
      userId: actor.userId
    });
    if (!reader) return null;
    const found = await this.readPlan(reader);
    if (!found) return null;
    const { file, plan } = found;
    // Resolved at call time rather than import time: this service sits in a
    // cycle with the deployments service, and a top-level import here would
    // evaluate that class before it exists under swc's live bindings.
    const [{ DeploymentsService }, { DatabasesService }, { IngressService }] = await Promise.all([
      import('../projects/deployments.service.js'),
      import('../projects/databases.service.js'),
      import('../projects/ingress.service.js')
    ]);
    const deployments = this.moduleRef.get(DeploymentsService, { strict: false });
    const databases = this.moduleRef.get(DatabasesService, { strict: false });
    const ingress = this.moduleRef.get(IngressService, { strict: false });

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: { select: { id: true, organizationId: true } },
        services: { include: { ports: true }, orderBy: { createdAt: 'asc' } },
        resourceBindings: true,
        envVars: { select: { key: true, secret: true } }
      }
    });
    if (!deployment) return null;
    const warnings = [...plan.warnings];
    const applied: string[] = [];
    const bound = new Map(deployment.resourceBindings.map((b) => [b.name, b]));

    for (const resource of plan.resources) {
      if (resource.type !== 'postgres') continue;
      const bindingName = bindingNameForResource(resource.name);
      if (bound.has(bindingName)) continue;
      try {
        let db = await this.prisma.database.findFirst({
          where: { projectId: deployment.projectId, name: resource.name },
          select: { id: true, name: true }
        });
        if (!db) {
          const created = await databases.createDatabase(
            deployment.projectId,
            { name: resource.name, environmentId: deployment.environmentId ?? undefined },
            actor.clerkId,
            actor.userData
          );
          db = { id: created.id, name: created.name };
          applied.push(`created database ${resource.name}`);
        }
        await this.bindings.bind(
          deploymentId,
          { resourceType: 'database', resourceId: db.id, name: bindingName },
          actor.userId
        );
        applied.push(`bound ${resource.name} as ${bindingName}`);
      } catch (e) {
        warnings.push(`Resource ${resource.name}: ${(e as Error).message}`);
      }
    }

    if (plan.env.length > 0) {
      try {
        const declared = new Set(plan.env.map((e) => e.key));
        const kept = deployment.envVars
          .filter((v) => !declared.has(v.key))
          .map((v) => ({ key: v.key, value: null, secret: v.secret }));
        await deployments.updateDeploymentEnvVars(
          deploymentId,
          [...kept, ...plan.env.map((e) => ({ key: e.key, value: e.value }))],
          actor.clerkId,
          actor.userData
        );
        applied.push(`set ${plan.env.length} variable${plan.env.length === 1 ? '' : 's'}`);
      } catch (e) {
        warnings.push(`Variables: ${(e as Error).message}`);
      }
    }

    const service = deployment.services[0];
    if (plan.ports.length > 0 && service) {
      const current = service.ports
        .map((p) => `${p.port}:${p.targetPort}/${p.protocol}`)
        .sort()
        .join(',');
      const wanted = plan.ports
        .map((p) => `${p.port}:${p.targetPort}/${p.protocol}`)
        .sort()
        .join(',');
      if (current !== wanted) {
        try {
          await deployments.updateServiceConfiguration(
            deploymentId,
            service.id,
            {
              ports: plan.ports.map((p) => ({
                name: p.name,
                containerPort: p.targetPort,
                servicePort: p.port,
                protocol: p.protocol
              }))
            },
            actor.clerkId,
            actor.userData
          );
          applied.push(`set ports ${plan.ports.map((p) => p.port).join(', ')}`);
        } catch (e) {
          warnings.push(`Ports: ${(e as Error).message}`);
        }
      }
    }

    if (plan.replicas !== null && plan.replicas !== deployment.replicas) {
      try {
        await deployments.scaleDeployment(
          deploymentId,
          plan.replicas,
          actor.clerkId,
          actor.userData
        );
        applied.push(`scaled to ${plan.replicas}`);
      } catch (e) {
        warnings.push(`Replicas: ${(e as Error).message}`);
      }
    }

    if (plan.domain) {
      try {
        const existing = await this.prisma.ingress.findFirst({
          where: { host: plan.domain },
          select: { id: true, deploymentId: true }
        });
        const service = deployment.services[0];
        const servicePort = service?.ports[0]?.port;
        if (!existing && !servicePort) {
          warnings.push(`Domain ${plan.domain}: this app has no port to route to yet`);
        } else if (!existing) {
          await ingress.createProjectIngress(
            deployment.projectId,
            {
              host: plan.domain,
              deploymentId,
              tlsEnabled: true,
              routes: [{ path: '/', serviceName: service.name, servicePort: servicePort! }]
            },
            actor.clerkId,
            actor.userData
          );
          applied.push(`routed ${plan.domain}`);
        } else if (existing.deploymentId !== deploymentId) {
          warnings.push(`Domain ${plan.domain} is already routed to another app`);
        }
      } catch (e) {
        warnings.push(`Domain ${plan.domain}: ${(e as Error).message}`);
      }
    }

    if (plan.healthPath) {
      warnings.push("orchard.my/health-path is noted but health checks aren't set from Score yet");
    }

    if (applied.length > 0) {
      void this.audit.log({
        action: 'deployment.score.applied',
        actorUserId: actor.userId,
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        targetType: 'deployment',
        targetId: deploymentId,
        targetLabel: deployment.name,
        metadata: { file, applied: applied.join('; '), warnings: warnings.join('; ') || null }
      });
    }
    this.logger.log(
      `[Score] ${deployment.name}: ${applied.length ? applied.join('; ') : 'nothing to change'}${warnings.length ? ` (warnings: ${warnings.join('; ')})` : ''}`
    );
    return { ...summarize(file, plan), warnings, applied };
  }
}
