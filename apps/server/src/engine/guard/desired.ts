import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveNamespaceScope } from '../../projects/namespace-scope';
import {
  CILIUM_INGRESS_POLICY,
  CNPG_APISERVER_POLICY,
  CNPG_OPERATOR_POLICY,
  DATABASE_PLATFORM_POLICY,
  PROJECT_DATABASES_POLICY,
  TENANT_DENY_POLICY,
  basicAuthEnvoyConfig,
  basicAuthSecretName,
  ciliumIngressPolicy,
  cnpgApiserverPolicy,
  cnpgOperatorPolicy,
  databasePlatformPolicy,
  namespaceHasProtectedIngress,
  projectDatabasePolicy,
  projectNamespaces,
  publicDatabasePolicy,
  publicDatabasePolicyName,
  publicDeploymentPolicy,
  publicDeploymentPolicyName,
  publicDeploymentPorts,
  tenantDenyPolicy
} from '../../kubernetes/security-policies';
import { GuardKind, GuardManifest } from './compare';
import { GuardCluster, GuardKey } from './cluster';

export interface GuardScope {
  projectId: string;
  organizationId: string;
}

export interface DesiredObject {
  manifest: GuardManifest;
  scope: GuardScope;
}

export interface GuardDesired {
  desired(key: GuardKey, hint: GuardManifest | null): Promise<DesiredObject | null>;
  expected(kind: GuardKind): Promise<GuardKey[]>;
}

const AUTH_SUFFIX = '-auth';

export class PrismaGuardDesired implements GuardDesired {
  private readonly logger = new Logger('GuardDesired');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ciliumAvailable: () => Promise<boolean>,
    private readonly cluster: GuardCluster
  ) {}

  async desired(key: GuardKey, hint: GuardManifest | null): Promise<DesiredObject | null> {
    const scope = await resolveNamespaceScope(this.prisma, key.namespace);
    if (!scope) return null;
    const manifest = await this.build(key, scope.projectId, hint);
    if (!manifest) return null;
    return {
      manifest,
      scope: { projectId: scope.projectId, organizationId: scope.organizationId }
    };
  }

  async expected(kind: GuardKind): Promise<GuardKey[]> {
    if (kind === 'CiliumEnvoyConfig') return [];
    const projects = await this.prisma.project.findMany({
      select: { namespace: true, environments: { select: { namespace: true } } }
    });
    const owned = new Set<string>();
    const keys: GuardKey[] = [];
    const add = (namespace: string, name: string) => {
      if (owned.has(namespace)) keys.push({ kind, namespace, name });
    };
    const groups = projects.map((p) => projectNamespaces(p));
    for (const group of groups) for (const ns of group) owned.add(ns);

    if (kind === 'NetworkPolicy') {
      for (const group of groups) {
        for (const ns of group) {
          add(ns, TENANT_DENY_POLICY);
          if (group.length >= 2) add(ns, PROJECT_DATABASES_POLICY);
        }
      }
      const ports = await this.prisma.servicePort.findMany({
        where: { publicEnabled: true },
        select: { service: { select: { deployment: { select: { name: true, namespace: true } } } } }
      });
      const seen = new Set<string>();
      for (const port of ports) {
        const deployment = port.service?.deployment;
        if (!deployment) continue;
        const id = `${deployment.namespace}/${deployment.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        add(deployment.namespace, publicDeploymentPolicyName(deployment.name));
      }
      const databases = await this.prisma.database.findMany({
        where: { publicEnabled: true, namespace: { not: null }, clusterName: { not: null } },
        select: { namespace: true, clusterName: true }
      });
      for (const db of databases) add(db.namespace!, publicDatabasePolicyName(db.clusterName!));
      const managed = await this.prisma.database.findMany({
        where: { mode: 'cnpg', namespace: { not: null } },
        select: { namespace: true },
        distinct: ['namespace']
      });
      for (const db of managed) add(db.namespace!, DATABASE_PLATFORM_POLICY);
      return keys;
    }

    if (!(await this.ciliumAvailable())) return [];
    for (const ns of owned) {
      add(ns, CILIUM_INGRESS_POLICY);
      add(ns, CNPG_APISERVER_POLICY);
    }
    const cnpg = await this.prisma.database.findMany({
      where: { mode: 'cnpg', namespace: { not: null } },
      select: { namespace: true },
      distinct: ['namespace']
    });
    for (const db of cnpg) add(db.namespace!, CNPG_OPERATOR_POLICY);
    return keys;
  }

  private async build(
    key: GuardKey,
    projectId: string,
    hint: GuardManifest | null
  ): Promise<GuardManifest | null> {
    if (key.kind === 'NetworkPolicy') return this.networkPolicy(key, projectId);
    if (!(await this.ciliumAvailable())) return null;
    if (key.kind === 'CiliumNetworkPolicy') return this.ciliumPolicy(key);
    return this.envoyConfig(key, hint);
  }

  private async networkPolicy(key: GuardKey, projectId: string): Promise<GuardManifest | null> {
    const ns = key.namespace;
    if (key.name === TENANT_DENY_POLICY) {
      return tenantDenyPolicy(ns, {
        allowProtectionProxy: await namespaceHasProtectedIngress(this.prisma, ns)
      }) as GuardManifest;
    }
    if (key.name === DATABASE_PLATFORM_POLICY) {
      const count = await this.prisma.database.count({ where: { mode: 'cnpg', namespace: ns } });
      return count > 0 ? (databasePlatformPolicy(ns) as GuardManifest) : null;
    }
    if (key.name === PROJECT_DATABASES_POLICY) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { namespace: true, environments: { select: { namespace: true } } }
      });
      if (!project) return null;
      const namespaces = projectNamespaces(project);
      if (namespaces.length < 2 || !namespaces.includes(ns)) return null;
      return projectDatabasePolicy(ns, namespaces) as GuardManifest;
    }

    const [deployments, databases] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { namespace: ns },
        select: { id: true, name: true }
      }),
      this.prisma.database.findMany({
        where: { namespace: ns, publicEnabled: true, clusterName: { not: null } },
        select: { clusterName: true }
      })
    ]);
    const deployment = deployments.filter((d) => publicDeploymentPolicyName(d.name) === key.name);
    const database = databases.filter((d) => publicDatabasePolicyName(d.clusterName!) === key.name);
    if (deployment.length + database.length > 1) {
      this.logger.warn(
        `${ns}/${key.name} matches more than one public policy owner; not enforcing it`
      );
      return null;
    }
    if (deployment.length === 1) {
      const ports = publicDeploymentPorts(
        await this.prisma.servicePort.findMany({
          where: { publicEnabled: true, service: { deploymentId: deployment[0].id } },
          select: { targetPort: true, protocol: true }
        })
      );
      if (ports.length === 0) return null;
      return publicDeploymentPolicy(ns, deployment[0].name, ports) as GuardManifest;
    }
    if (database.length === 1) {
      return publicDatabasePolicy(ns, database[0].clusterName!) as GuardManifest;
    }
    return null;
  }

  private async ciliumPolicy(key: GuardKey): Promise<GuardManifest | null> {
    if (key.name === CILIUM_INGRESS_POLICY) return ciliumIngressPolicy(key.namespace);
    if (key.name === CNPG_APISERVER_POLICY) return cnpgApiserverPolicy(key.namespace);
    if (key.name === CNPG_OPERATOR_POLICY) {
      const count = await this.prisma.database.count({
        where: { mode: 'cnpg', namespace: key.namespace }
      });
      return count > 0 ? cnpgOperatorPolicy(key.namespace) : null;
    }
    return null;
  }

  private async envoyConfig(
    key: GuardKey,
    hint: GuardManifest | null
  ): Promise<GuardManifest | null> {
    if (!key.name.endsWith(AUTH_SUFFIX)) return null;
    const ingressName = key.name.slice(0, -AUTH_SUFFIX.length);
    const rows = await this.prisma.ingress.findMany({
      where: { namespace: key.namespace, name: ingressName },
      orderBy: { createdAt: 'asc' },
      select: { servicePort: true, service: { select: { name: true, port: true } } }
    });
    if (rows.length === 0) return null;
    const users = await this.cluster.secretValue(
      key.namespace,
      basicAuthSecretName(ingressName),
      'users'
    );
    if (!users) return null;
    const targets = rows
      .filter((r) => r.service)
      .map((r) => ({ name: r.service!.name, port: r.servicePort ?? r.service!.port }));
    if (targets.length === 0) {
      this.logger.warn(
        `basic auth for ${key.namespace}/${ingressName} has no service on record; not enforcing it`
      );
      return null;
    }
    const hinted = hint?.spec?.services?.[0];
    const target =
      targets.find(
        (t) => hinted && t.name === hinted.name && t.port === Number(hinted.ports?.[0])
      ) ?? targets[0];
    return basicAuthEnvoyConfig(key.namespace, ingressName, users, target.name, target.port);
  }
}
