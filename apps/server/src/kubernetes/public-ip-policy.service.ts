import {
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { KubernetesService } from './kubernetes.service';
import { canonicalIp, foreignHolders, type ShareWith } from './public-ip-policy';

@Injectable()
export class PublicIpPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly instanceConfig: InstanceConfigService,
    @Optional() private readonly settings?: InstanceSettingsService
  ) {}

  private isInstanceDefault(ip: string): boolean {
    const fallback = canonicalIp(this.instanceConfig.defaultPublicIp());
    return fallback !== null && fallback === canonicalIp(ip);
  }

  private async sharingAllowed(): Promise<boolean> {
    return this.settings ? this.settings.isPublicIpSharingAllowed() : false;
  }

  async orgNamespaces(organizationId: string): Promise<string[]> {
    const projects = await this.prisma.project.findMany({
      where: { organizationId },
      select: { namespace: true, environments: { select: { namespace: true } } }
    });
    const out = new Set<string>();
    for (const project of projects) {
      if (project.namespace) out.add(project.namespace);
      for (const env of project.environments) if (env.namespace) out.add(env.namespace);
    }
    return [...out].sort();
  }

  private async orgOfNamespace(namespace: string): Promise<string | null> {
    const env = await this.prisma.environment.findUnique({
      where: { namespace },
      select: { project: { select: { organizationId: true } } }
    });
    if (env) return env.project.organizationId;
    const project = await this.prisma.project.findFirst({
      where: { namespace },
      select: { organizationId: true }
    });
    return project?.organizationId ?? null;
  }

  async assertOrgMayUse(organizationId: string, ip: string): Promise<void> {
    if (this.isInstanceDefault(ip) || (await this.sharingAllowed())) return;

    const others = await this.prisma.organization.findMany({
      where: { id: { not: organizationId }, databasePublicIp: { not: null } },
      select: { databasePublicIp: true }
    });
    if (others.some((o) => canonicalIp(o.databasePublicIp) === ip)) {
      throw new ConflictException(
        'Another organization already uses this IP. An instance admin can allow organizations to share an IP.'
      );
    }

    const own = new Set(await this.orgNamespaces(organizationId));
    let services: k8s.V1Service[];
    try {
      services = (await this.kubernetes.getCoreV1Api().listServiceForAllNamespaces()).body.items;
    } catch {
      throw new ServiceUnavailableException(
        "Couldn't confirm that no other tenant holds this IP because Kubernetes didn't answer. Try again shortly."
      );
    }
    if (foreignHolders(services, ip, own).length > 0) {
      throw new ConflictException(
        'A load balancer outside this organization already holds this IP. An instance admin can allow organizations to share an IP.'
      );
    }
  }

  async shareWith(namespace: string, ip: string): Promise<ShareWith> {
    if (this.isInstanceDefault(ip) || (await this.sharingAllowed())) return '*';
    const organizationId = await this.orgOfNamespace(namespace);
    const own = organizationId ? await this.orgNamespaces(organizationId) : [];
    return [...new Set([namespace, ...own])].sort();
  }
}
