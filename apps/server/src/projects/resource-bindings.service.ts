import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrgEventsService } from '../events/org-events.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { referencedResourceRefs, type ResourceValues } from '../env/env-resolver';

export type BindableResourceType = 'database' | 'deployment';

export const BINDING_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_BINDINGS = 20;

export const DATABASE_FIELDS = [
  'connection_string',
  'host',
  'port',
  'database',
  'user',
  'password'
] as const;
export const DEPLOYMENT_FIELDS = ['url', 'host', 'port'] as const;
const DATABASE_SECRET_FIELDS: readonly string[] = ['connection_string', 'password'];

export const PRIMARY_FIELD: Record<BindableResourceType, string> = {
  database: 'connection_string',
  deployment: 'url'
};

export interface DatabaseCredentials {
  dbUser: string;
  dbPassword: string;
  host: string;
  port: number;
  dbName: string;
}

export interface ServiceEndpoint {
  name: string;
  port: number;
  ports: { port: number }[];
}

export function databaseFields(db: DatabaseCredentials): Record<string, string> {
  const user = encodeURIComponent(db.dbUser);
  const password = encodeURIComponent(db.dbPassword);
  return {
    connection_string: `postgresql://${user}:${password}@${db.host}:${db.port}/${db.dbName}`,
    host: db.host,
    port: String(db.port),
    database: db.dbName,
    user: db.dbUser,
    password: db.dbPassword
  };
}

/**
 * The first Service of the app on its Service port, which is what in-cluster
 * traffic hits. An app with no Service has no fields at all, so a reference
 * to it fails at inject time rather than resolving to a host nobody answers on.
 */
export function deploymentFields(
  namespace: string,
  services: ServiceEndpoint[]
): Record<string, string> {
  const service = services[0];
  if (!service) return {};
  const host = `${service.name}.${namespace}.svc.cluster.local`;
  const port = service.ports[0]?.port || service.port || 80;
  return { url: `http://${host}:${port}`, host, port: String(port) };
}

export function endpointLabel(fields: Record<string, string>): string | null {
  if (fields.host && fields.port) return `${fields.host}:${fields.port}`;
  return null;
}

export function bindingNameFor(resourceName: string): string {
  const base = resourceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (!base) return 'resource';
  return /^[a-z]/.test(base) ? base : `r_${base}`.slice(0, 32);
}

export function resourceRef(name: string, field: string): string {
  return `\${{resource.${name}.${field}}}`;
}

export interface BindingView {
  id: string;
  name: string;
  resourceType: BindableResourceType;
  resourceId: string;
  resource: { name: string; status: string } | null;
  endpoint: string | null;
  fields: readonly string[];
  usedBy: string[];
  createdAt: Date;
}

export interface BindingOption {
  resourceType: BindableResourceType;
  resourceId: string;
  name: string;
  status: string;
  endpoint: string | null;
  suggestedName: string;
}

export interface BindInput {
  resourceType?: string;
  resourceId?: string;
  name?: string;
}

type DatabaseRow = DatabaseCredentials & { id: string; name: string; status: string };
type DeploymentRow = {
  id: string;
  name: string;
  displayName: string | null;
  status: string;
  namespace: string;
  services: ServiceEndpoint[];
};

@Injectable()
export class ResourceBindingsService {
  private readonly logger = new Logger(ResourceBindingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orgEvents: OrgEventsService,
    private readonly crypto: SecretCryptoService
  ) {}

  private async deploymentOrThrow(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!deployment) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    return deployment;
  }

  private async databasesById(ids: string[]): Promise<Map<string, DatabaseRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.database.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        status: true,
        dbUser: true,
        dbPassword: true,
        host: true,
        port: true,
        dbName: true
      }
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async deploymentsById(ids: string[]): Promise<Map<string, DeploymentRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.deployment.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        displayName: true,
        status: true,
        namespace: true,
        services: {
          select: { name: true, port: true, ports: { select: { port: true } } },
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async resourcesFor(rows: { resourceType: string; resourceId: string }[]) {
    const [dbs, deps] = await Promise.all([
      this.databasesById(
        rows.filter((r) => r.resourceType === 'database').map((r) => r.resourceId)
      ),
      this.deploymentsById(
        rows.filter((r) => r.resourceType === 'deployment').map((r) => r.resourceId)
      )
    ]);
    return { dbs, deps };
  }

  private fieldsFor(
    row: { resourceType: string; resourceId: string },
    dbs: Map<string, DatabaseRow>,
    deps: Map<string, DeploymentRow>
  ): { fields: Record<string, string>; secretFields: readonly string[] } | null {
    if (row.resourceType === 'database') {
      const db = dbs.get(row.resourceId);
      return db ? { fields: databaseFields(db), secretFields: DATABASE_SECRET_FIELDS } : null;
    }
    const dep = deps.get(row.resourceId);
    return dep ? { fields: deploymentFields(dep.namespace, dep.services), secretFields: [] } : null;
  }

  async list(deploymentId: string): Promise<BindingView[]> {
    const [rows, vars] = await Promise.all([
      this.prisma.resourceBinding.findMany({
        where: { deploymentId },
        orderBy: { createdAt: 'asc' }
      }),
      this.prisma.deploymentEnvVar.findMany({
        where: { deploymentId },
        select: { key: true, value: true, secret: true }
      })
    ]);
    const refs = referencedResourceRefs(vars.map((v) => this.crypto.maybeDecrypt(v)));
    const { dbs, deps } = await this.resourcesFor(rows);
    return rows.map((r) => {
      const type = r.resourceType as BindableResourceType;
      const values = this.fieldsFor(r, dbs, deps);
      const resource =
        type === 'database' ? (dbs.get(r.resourceId) ?? null) : (deps.get(r.resourceId) ?? null);
      const usedBy = [...new Set(refs.filter((x) => x.binding === r.name).map((x) => x.key))];
      return {
        id: r.id,
        name: r.name,
        resourceType: type,
        resourceId: r.resourceId,
        resource: resource
          ? {
              name:
                type === 'deployment'
                  ? ((resource as DeploymentRow).displayName ?? resource.name)
                  : resource.name,
              status: resource.status
            }
          : null,
        endpoint: values ? endpointLabel(values.fields) : null,
        fields: type === 'database' ? DATABASE_FIELDS : DEPLOYMENT_FIELDS,
        usedBy: usedBy.sort(),
        createdAt: r.createdAt
      };
    });
  }

  async options(deploymentId: string): Promise<BindingOption[]> {
    const deployment = await this.deploymentOrThrow(deploymentId);
    const [databases, deployments, bound] = await Promise.all([
      this.prisma.database.findMany({
        where: { projectId: deployment.projectId },
        select: { id: true, name: true, status: true, host: true, port: true },
        orderBy: { name: 'asc' }
      }),
      this.prisma.deployment.findMany({
        where: { projectId: deployment.projectId, id: { not: deploymentId } },
        select: {
          id: true,
          name: true,
          displayName: true,
          status: true,
          namespace: true,
          services: {
            select: { name: true, port: true, ports: { select: { port: true } } },
            orderBy: { createdAt: 'asc' }
          }
        },
        orderBy: { name: 'asc' }
      }),
      this.prisma.resourceBinding.findMany({
        where: { deploymentId },
        select: { resourceId: true, name: true }
      })
    ]);
    const boundIds = new Set(bound.map((b) => b.resourceId));
    const taken = new Set(bound.map((b) => b.name));
    const suggest = (name: string) => {
      let suggested = bindingNameFor(name);
      let n = 2;
      while (taken.has(suggested)) suggested = `${bindingNameFor(name).slice(0, 30)}_${n++}`;
      taken.add(suggested);
      return suggested;
    };
    const out: BindingOption[] = [];
    for (const db of databases) {
      if (boundIds.has(db.id)) continue;
      out.push({
        resourceType: 'database',
        resourceId: db.id,
        name: db.name,
        status: db.status,
        endpoint: `${db.host}:${db.port}`,
        suggestedName: suggest(db.name)
      });
    }
    for (const dep of deployments) {
      if (boundIds.has(dep.id)) continue;
      out.push({
        resourceType: 'deployment',
        resourceId: dep.id,
        name: dep.displayName ?? dep.name,
        status: dep.status,
        endpoint: endpointLabel(deploymentFields(dep.namespace, dep.services)),
        suggestedName: suggest(dep.name)
      });
    }
    return out;
  }

  async bind(deploymentId: string, input: BindInput, userId: string): Promise<BindingView> {
    const deployment = await this.deploymentOrThrow(deploymentId);
    const type = input.resourceType;
    if (type !== 'database' && type !== 'deployment') {
      throw new BadRequestException('resourceType must be database or deployment');
    }
    const resourceId = String(input.resourceId || '').trim();
    if (!resourceId) throw new BadRequestException('resourceId is required');
    let resourceName: string;
    if (type === 'database') {
      const db = await this.prisma.database.findUnique({
        where: { id: resourceId },
        select: { id: true, name: true, projectId: true }
      });
      if (!db || db.projectId !== deployment.projectId) {
        throw new NotFoundException('Database not found on this project');
      }
      resourceName = db.name;
    } else {
      if (resourceId === deploymentId) {
        throw new BadRequestException('An app cannot be connected to itself');
      }
      const dep = await this.prisma.deployment.findUnique({
        where: { id: resourceId },
        select: { id: true, name: true, displayName: true, projectId: true }
      });
      if (!dep || dep.projectId !== deployment.projectId) {
        throw new NotFoundException('App not found on this project');
      }
      resourceName = dep.name;
    }
    const name = String(input.name || bindingNameFor(resourceName)).trim();
    if (!BINDING_NAME_RE.test(name)) {
      throw new BadRequestException(
        'Binding name must start with a letter and use only lowercase letters, digits and underscores'
      );
    }
    const existing = await this.prisma.resourceBinding.findMany({
      where: { deploymentId },
      select: { name: true, resourceId: true }
    });
    if (existing.length >= MAX_BINDINGS) {
      throw new BadRequestException(`An app can connect to at most ${MAX_BINDINGS} resources`);
    }
    if (existing.some((b) => b.name === name)) {
      throw new BadRequestException(`${name} is already used by another connection`);
    }
    if (existing.some((b) => b.resourceId === resourceId)) {
      throw new BadRequestException(`${resourceName} is already connected`);
    }
    const row = await this.prisma.resourceBinding.create({
      data: { deploymentId, resourceType: type, resourceId, name, createdById: userId }
    });
    void this.audit.log({
      action: 'deployment.binding.created',
      actorUserId: userId,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      targetType: 'deployment',
      targetId: deployment.id,
      targetLabel: deployment.name,
      metadata: { binding: name, resourceType: type, resourceId, resource: resourceName }
    });
    this.orgEvents.emit({
      organizationId: deployment.project.organizationId,
      type: 'deployment.changed',
      id: deployment.id,
      projectId: deployment.projectId
    });
    const view = (await this.list(deploymentId)).find((b) => b.id === row.id);
    if (!view) throw new NotFoundException('Binding not found after create');
    return view;
  }

  async unbind(deploymentId: string, bindingId: string, userId: string): Promise<void> {
    const deployment = await this.deploymentOrThrow(deploymentId);
    const row = await this.prisma.resourceBinding.findUnique({ where: { id: bindingId } });
    if (!row || row.deploymentId !== deploymentId) throw new NotFoundException('Binding not found');
    const users = await this.keysReferencing(deploymentId, row.name);
    if (users.length > 0) {
      throw new BadRequestException(
        `${users.join(', ')} still use${users.length === 1 ? 's' : ''} ${row.name}. Change or remove ${users.length === 1 ? 'it' : 'them'} first.`
      );
    }
    await this.prisma.resourceBinding.delete({ where: { id: row.id } });
    void this.audit.log({
      action: 'deployment.binding.removed',
      actorUserId: userId,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      targetType: 'deployment',
      targetId: deployment.id,
      targetLabel: deployment.name,
      metadata: { binding: row.name, resourceType: row.resourceType, resourceId: row.resourceId }
    });
    this.orgEvents.emit({
      organizationId: deployment.project.organizationId,
      type: 'deployment.changed',
      id: deployment.id,
      projectId: deployment.projectId
    });
  }

  private async keysReferencing(deploymentId: string, bindingName: string): Promise<string[]> {
    const vars = await this.prisma.deploymentEnvVar.findMany({
      where: { deploymentId },
      select: { key: true, value: true, secret: true }
    });
    const plain = vars.map((v) => this.crypto.maybeDecrypt(v));
    const keys = new Set<string>();
    for (const ref of referencedResourceRefs(plain)) {
      if (ref.binding === bindingName) keys.add(ref.key);
    }
    return [...keys].sort();
  }

  /**
   * A connection only exists to feed variables, so once nothing reads it
   * any more it goes. Runs after every env save.
   */
  async pruneUnreferenced(deploymentId: string): Promise<string[]> {
    const [rows, vars] = await Promise.all([
      this.prisma.resourceBinding.findMany({
        where: { deploymentId },
        select: { id: true, name: true }
      }),
      this.prisma.deploymentEnvVar.findMany({
        where: { deploymentId },
        select: { key: true, value: true, secret: true }
      })
    ]);
    if (rows.length === 0) return [];
    const used = new Set(
      referencedResourceRefs(vars.map((v) => this.crypto.maybeDecrypt(v))).map((r) => r.binding)
    );
    const stale = rows.filter((r) => !used.has(r.name));
    if (stale.length === 0) return [];
    await this.prisma.resourceBinding.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
    return stale.map((r) => r.name);
  }

  async valuesFor(deploymentId: string): Promise<ResourceValues> {
    const rows = await this.prisma.resourceBinding.findMany({
      where: { deploymentId },
      select: { name: true, resourceType: true, resourceId: true }
    });
    if (rows.length === 0) return {};
    const { dbs, deps } = await this.resourcesFor(rows);
    const out: ResourceValues = {};
    for (const r of rows) {
      const values = this.fieldsFor(r, dbs, deps);
      if (values) out[r.name] = values;
    }
    return out;
  }

  async boundDeployments(
    resourceType: BindableResourceType,
    resourceId: string
  ): Promise<{ id: string; name: string }[]> {
    const rows = await this.prisma.resourceBinding.findMany({
      where: { resourceType, resourceId },
      select: { deployment: { select: { id: true, name: true } } }
    });
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.deployment.id, r.deployment.name);
    return [...seen].map(([id, name]) => ({ id, name }));
  }
}
