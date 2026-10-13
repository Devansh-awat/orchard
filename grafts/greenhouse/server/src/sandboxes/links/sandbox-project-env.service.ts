import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { SecretCryptoService } from '../../core/secret-crypto.service';
import { AuthorizationService } from '../../core/authorization.service';
import { K8sCnpgService } from '../../core/kubernetes.service';
import { isEnvFileSlug, renderEnvFile, type EnvFileDatabase } from './sandbox-env-files';

export interface LinkedDatabaseRow {
  name: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  mode: string;
  namespace: string | null;
  clusterName: string | null;
  publicEnabled: boolean;
  publicIp: string | null;
  publicPort: number | null;
}

interface LinkRow {
  id: string;
  projectId: string;
  environmentId: string;
  createdById: string;
  project: { id: string; name: string; slug: string; organizationId: string };
  environment: { id: string; name: string; projectId: string };
}

export function publicDatabaseUrl(
  db: LinkedDatabaseRow,
  password: string,
  tlsHostname: string | null
): string | null {
  if (
    !db.publicEnabled ||
    !db.publicIp ||
    !db.publicPort ||
    db.mode !== 'cnpg' ||
    !db.clusterName ||
    !db.namespace
  ) {
    return null;
  }
  return tlsHostname
    ? `postgresql://${db.dbUser}:${password}@${tlsHostname}:${db.publicPort}/${db.dbName}?sslmode=verify-full&sslrootcert=system`
    : `postgresql://${db.dbUser}:${password}@${db.publicIp}:${db.publicPort}/${db.dbName}?sslmode=require`;
}

@Injectable()
export class SandboxProjectEnvService {
  private readonly logger = new Logger(SandboxProjectEnvService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly authz: AuthorizationService,
    private readonly cnpg: K8sCnpgService
  ) {}

  async filesFor(sandboxId: string): Promise<Record<string, string>> {
    const sandbox = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: { id: true, userId: true, organizationId: true, desiredState: true }
    });
    if (!sandbox || sandbox.desiredState === 'deleted') return {};
    const links: LinkRow[] = await this.prisma.sandboxProjectLink.findMany({
      where: { sandboxId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        projectId: true,
        environmentId: true,
        createdById: true,
        project: { select: { id: true, name: true, slug: true, organizationId: true } },
        environment: { select: { id: true, name: true, projectId: true } }
      }
    });
    const out: Record<string, string> = {};
    for (const link of links) {
      if (!isEnvFileSlug(link.project.slug) || out[link.project.slug] !== undefined) continue;
      if (!(await this.stillAuthorized(sandbox, link))) {
        this.logger.warn(`skipping env for ${link.project.slug} in ${sandbox.id}: access revoked`);
        continue;
      }
      out[link.project.slug] = await this.render(link);
    }
    return out;
  }

  async stillAuthorized(
    sandbox: { userId: string; organizationId: string | null },
    link: Pick<LinkRow, 'projectId' | 'createdById' | 'project' | 'environment'>
  ): Promise<boolean> {
    if (link.environment.projectId !== link.projectId) return false;
    if (sandbox.organizationId && link.project.organizationId !== sandbox.organizationId) {
      return false;
    }
    if (link.createdById !== sandbox.userId && !(await this.authz.isSuperAdmin(link.createdById))) {
      return false;
    }
    const access = await this.authz
      .resolveProjectAccess(link.projectId, link.project.organizationId, link.createdById)
      .catch(() => null);
    return !!access?.canEdit;
  }

  private async render(link: LinkRow): Promise<string> {
    const [shared, databases] = await Promise.all([
      this.prisma.environmentSharedVar.findMany({
        where: { environmentId: link.environmentId },
        select: { key: true, value: true, secret: true }
      }),
      this.prisma.database.findMany({
        where: { projectId: link.projectId, environmentId: link.environmentId },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: {
          name: true,
          dbName: true,
          dbUser: true,
          dbPassword: true,
          mode: true,
          namespace: true,
          clusterName: true,
          publicEnabled: true,
          publicIp: true,
          publicPort: true
        }
      })
    ]);
    return renderEnvFile({
      projectName: link.project.name,
      environmentName: link.environment.name,
      vars: shared.map((v) =>
        v.secret ? { key: v.key, value: '', secret: true } : { key: v.key, value: v.value }
      ),
      database: databases[0] ? this.databaseEntry(databases[0]) : null
    });
  }

  private databaseEntry(db: LinkedDatabaseRow): EnvFileDatabase {
    const reachable =
      db.publicEnabled && db.mode === 'cnpg' && db.namespace && db.clusterName && db.publicPort;
    if (!reachable) return { name: db.name, url: null };
    const hostname = this.cnpg.publicTlsHostname(db.namespace!, db.clusterName!) || null;
    return {
      name: db.name,
      url: publicDatabaseUrl(db, this.crypto.open(db.dbPassword) ?? '', hostname)
    };
  }
}
