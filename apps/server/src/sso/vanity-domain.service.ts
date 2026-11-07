import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { optionalDomain } from '../env/platform-domains';
import { CERT_CLUSTER_ISSUER } from '../projects/projects.utils';
import {
  isReservedSubdomainLabel,
  lockHostnameClaims,
  normalizeHost
} from '../instance-network/reserved-hosts';

/**
 * An org's vanity host. Login lives at /<org-slug> on the main domain, so this
 * is purely a nicer URL: acme.orchard.my resolves and the frontend redirects it
 * to orchard.my/acme/login.
 */
@Injectable()
export class VanityDomainService {
  private readonly logger = new Logger(VanityDomainService.name);

  private readonly baseDomain: string;

  private readonly platformNamespace: string;

  private readonly platformServiceName: string;

  private readonly platformServicePort: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sNetwork: K8sNetworkService
  ) {
    this.baseDomain = optionalDomain(process.env.BASE_DOMAIN);
    this.platformNamespace = process.env.PLATFORM_NAMESPACE || 'default';
    this.platformServiceName = process.env.PLATFORM_SERVICE_NAME || 'leaf-frontend';
    this.platformServicePort = parseInt(process.env.PLATFORM_SERVICE_PORT || '3000', 10);
  }

  async setSubdomain(organizationId: string, subdomain: string | null) {
    const normalized = subdomain
      ? normalizeHost(subdomain) || subdomain.trim().toLowerCase()
      : null;

    if (normalized) {
      if (!this.baseDomain) {
        throw new BadRequestException(
          "This instance has no vanity domain (BASE_DOMAIN), so organization subdomains aren't available."
        );
      }
      if (!/^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])?$/.test(normalized)) {
        throw new BadRequestException(
          "Subdomain must be 3 to 50 letters, digits or hyphens, and can't start or end with a hyphen"
        );
      }
      if (isReservedSubdomainLabel(normalized, this.baseDomain)) {
        throw new BadRequestException('This subdomain is reserved');
      }
    }

    const { result, oldSubdomain } = await this.prisma.$transaction(async (tx) => {
      if (normalized) await lockHostnameClaims(tx);
      const current = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { subdomain: true }
      });

      if (normalized) {
        const [conflict, page, ingress] = await Promise.all([
          tx.organization.findFirst({
            where: { subdomain: normalized, NOT: { id: organizationId } },
            select: { id: true }
          }),
          tx.statusPage.findUnique({ where: { subdomain: normalized }, select: { id: true } }),
          tx.ingress.findFirst({
            where: {
              host: { equals: `${normalized}.${this.baseDomain}`, mode: 'insensitive' }
            },
            select: { id: true }
          })
        ]);
        if (conflict || page || ingress) {
          throw new ConflictException('This subdomain is already taken');
        }
      }

      let updated;
      try {
        updated = await tx.organization.update({
          where: { id: organizationId },
          data: { subdomain: normalized }
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new ConflictException('This subdomain is already taken');
        }
        throw err;
      }
      return { result: updated, oldSubdomain: current?.subdomain ?? null };
    });

    // Ingress work happens after the DB commit; on failure the subdomain goes
    // back to what it was so the record and the cluster don't diverge.
    try {
      if (oldSubdomain && oldSubdomain !== normalized) {
        await this.deleteIngress(oldSubdomain);
      }
      if (normalized) await this.ensureIngress(normalized);
    } catch (err) {
      this.logger.error(
        `Ingress work failed for subdomain ${normalized ?? 'null'}; reverting to ${oldSubdomain ?? 'null'}`,
        err instanceof Error ? err.stack : String(err)
      );
      await this.prisma.organization
        .update({ where: { id: organizationId }, data: { subdomain: oldSubdomain } })
        .catch((revertErr) => {
          this.logger.error(
            `Failed to revert subdomain for org ${organizationId}`,
            revertErr instanceof Error ? revertErr.stack : String(revertErr)
          );
        });
      throw err;
    }

    return result;
  }

  private ingressName(subdomain: string): string {
    return `sso-${subdomain}`.substring(0, 63);
  }

  private async ensureIngress(subdomain: string) {
    const host = `${subdomain}.${this.baseDomain}`;
    const opts = {
      namespace: this.platformNamespace,
      name: this.ingressName(subdomain),
      host,
      path: '/',
      pathType: 'Prefix',
      serviceName: this.platformServiceName,
      servicePort: this.platformServicePort,
      tlsSecretName: `sso-tls-${subdomain}`,
      tlsHosts: [host],
      annotations: { 'cert-manager.io/cluster-issuer': CERT_CLUSTER_ISSUER }
    };

    try {
      await this.k8sNetwork.createIngress(opts);
      this.logger.log(`Created vanity ingress for ${host}`);
    } catch (error) {
      if (error?.response?.error === 'Ingress already exists') {
        await this.k8sNetwork.updateIngress(opts);
        this.logger.log(`Updated vanity ingress for ${host}`);
      } else {
        throw error;
      }
    }
  }

  private async deleteIngress(subdomain: string) {
    try {
      await this.k8sNetwork.deleteIngress(this.platformNamespace, this.ingressName(subdomain));
      this.logger.log(`Deleted vanity ingress for ${subdomain}.${this.baseDomain}`);
    } catch (error) {
      this.logger.warn(`Failed to delete vanity ingress "${subdomain}": ${error?.message}`);
    }
  }
}
