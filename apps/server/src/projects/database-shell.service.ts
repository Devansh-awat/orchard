import {
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { tenantRuntimeClassName } from '../kubernetes/trusted-images';
import {
  PSQL_CONTAINER,
  PSQL_DATABASE_LABEL,
  PSQL_SELECTOR,
  isPsqlSessionPod,
  isStalePsqlPod,
  psqlMaxSessions,
  psqlPodState,
  psqlSessionName,
  psqlSessionPod,
  psqlSessionSecret,
  psqlSessionTtlSeconds
} from '../kubernetes/psql-session';
import { isValidPodName } from '../kubernetes/pod-name';
import { ProjectAccessService } from './project-access.service';
import { DatabasesService } from './databases.service';
import { resolveNamespaceScope } from './namespace-scope';

export interface PsqlClusterPort {
  createPod(namespace: string, pod: k8s.V1Pod): Promise<k8s.V1Pod>;
  createSecret(namespace: string, secret: k8s.V1Secret): Promise<void>;
  readPod(namespace: string, name: string): Promise<k8s.V1Pod | null>;
  deletePod(namespace: string, name: string): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  listPods(namespace: string | null): Promise<k8s.V1Pod[]>;
}

export interface PsqlSession {
  namespace: string;
  pod: string;
  container: string;
  expiresInSeconds: number;
}

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 750;
const SWEEP_MS = 120_000;
const SHELL_MODES = new Set(['cnpg', 'container']);

function notFound(err: unknown): boolean {
  const e = err as { response?: { statusCode?: number }; statusCode?: number };
  return (e?.response?.statusCode ?? e?.statusCode) === 404;
}

export function kubePsqlCluster(kc: k8s.KubeConfig): PsqlClusterPort {
  const core = () => kc.makeApiClient(k8s.CoreV1Api);
  const ignore404 = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (!notFound(err)) throw err;
    }
  };
  return {
    async createPod(namespace, pod) {
      return (await core().createNamespacedPod(namespace, pod)).body;
    },
    async createSecret(namespace, secret) {
      await core().createNamespacedSecret(namespace, secret);
    },
    async readPod(namespace, name) {
      try {
        return (await core().readNamespacedPod(name, namespace)).body;
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async deletePod(namespace, name) {
      await ignore404(core().deleteNamespacedPod(name, namespace, undefined, undefined, 0));
    },
    async deleteSecret(namespace, name) {
      await ignore404(core().deleteNamespacedSecret(name, namespace));
    },
    async listPods(namespace) {
      const api = core();
      const res = namespace
        ? await api.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            PSQL_SELECTOR
          )
        : await api.listPodForAllNamespaces(undefined, undefined, undefined, PSQL_SELECTOR);
      return res.body.items ?? [];
    }
  };
}

@Injectable()
export class DatabaseShellService {
  private readonly logger = new Logger(DatabaseShellService.name);

  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly databases: DatabasesService,
    private readonly kubernetes: KubernetesService,
    private readonly audit: AuditService,
    private readonly leader: LeaderElectionService
  ) {}

  protected cluster(): PsqlClusterPort {
    if (!this.kubernetes.kc) {
      throw new ServiceUnavailableException('Kubernetes API not available');
    }
    return kubePsqlCluster(this.kubernetes.kc);
  }

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async authorize(databaseId: string, clerkId: string, userData?: any) {
    const { user, database } = await this.access.assertDatabaseEditor(
      databaseId,
      clerkId,
      userData
    );
    if (!SHELL_MODES.has(database.mode) || !database.namespace) {
      throw new BadRequestException('Only dedicated databases have a SQL shell');
    }
    const scope = await resolveNamespaceScope(this.prisma, database.namespace);
    if (!scope || scope.projectId !== database.project.id) {
      throw new NotFoundException('Database not found');
    }
    return { user, database, namespace: database.namespace };
  }

  async open(databaseId: string, clerkId: string, userData?: any): Promise<PsqlSession> {
    const { user, database, namespace } = await this.authorize(databaseId, clerkId, userData);
    const cluster = this.cluster();

    const live = (await cluster.listPods(namespace)).filter(
      (pod) =>
        isPsqlSessionPod(pod) &&
        pod.metadata?.labels?.[PSQL_DATABASE_LABEL] === database.id &&
        pod.status?.phase !== 'Failed' &&
        pod.status?.phase !== 'Succeeded'
    );
    if (live.length >= psqlMaxSessions()) {
      throw new HttpException(
        'Too many open SQL shells for this database; close one first',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const connection = await this.databases.databaseConnection(database.id);
    if (!connection.password || !connection.host) {
      throw new BadRequestException('Database credentials are not ready yet');
    }

    const ttlSeconds = psqlSessionTtlSeconds();
    const name = psqlSessionName();
    const pod = await cluster.createPod(
      namespace,
      psqlSessionPod({
        name,
        namespace,
        image: this.databases.postgresImageFor(database.pgMajor),
        databaseId: database.id,
        userId: user.id,
        runtimeClassName: tenantRuntimeClassName(),
        ttlSeconds
      })
    );

    try {
      const uid = pod.metadata?.uid;
      if (!uid) throw new Error('pod has no uid');
      await cluster.createSecret(
        namespace,
        psqlSessionSecret({
          name,
          namespace,
          databaseId: database.id,
          userId: user.id,
          connection: {
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            database: connection.database
          },
          owner: { name, uid }
        })
      );
      await this.waitReady(cluster, namespace, name);
    } catch (err) {
      await this.discard(cluster, namespace, name);
      throw err;
    }

    void this.audit.log({
      action: 'database.shell.opened',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: database.project.organizationId,
      projectId: database.project.id,
      targetType: 'database',
      targetId: database.id,
      targetLabel: database.name,
      metadata: { namespace, pod: name }
    });
    return { namespace, pod: name, container: PSQL_CONTAINER, expiresInSeconds: ttlSeconds };
  }

  async close(
    databaseId: string,
    podName: string,
    clerkId: string,
    userData?: any
  ): Promise<{ closed: true }> {
    if (!isValidPodName(podName)) throw new BadRequestException('Invalid pod name');
    const { database, namespace } = await this.authorize(databaseId, clerkId, userData);
    const cluster = this.cluster();
    const pod = await cluster.readPod(namespace, podName);
    if (
      !pod ||
      !isPsqlSessionPod(pod) ||
      pod.metadata?.labels?.[PSQL_DATABASE_LABEL] !== database.id
    ) {
      throw new NotFoundException('SQL shell not found');
    }
    await this.discard(cluster, namespace, podName);
    return { closed: true };
  }

  private async discard(cluster: PsqlClusterPort, namespace: string, name: string) {
    await cluster.deletePod(namespace, name).catch((err) => {
      this.logger.warn(`delete psql pod ${namespace}/${name} failed: ${err?.message ?? err}`);
    });
    await cluster.deleteSecret(namespace, name).catch(() => {});
  }

  private async waitReady(cluster: PsqlClusterPort, namespace: string, name: string) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pod = await cluster.readPod(namespace, name);
      if (!pod) throw new ServiceUnavailableException('SQL shell pod disappeared');
      const state = psqlPodState(pod);
      if (state.state === 'ready') return;
      if (state.state === 'failed') {
        throw new ServiceUnavailableException(`SQL shell could not start: ${state.reason}`);
      }
      await this.delay(READY_POLL_MS);
    }
    throw new GatewayTimeoutException('SQL shell did not start in time');
  }

  @Interval(SWEEP_MS)
  async sweep(): Promise<number> {
    if (!this.leader.isLeader() || this.sweeping || !this.kubernetes.kc) return 0;
    this.sweeping = true;
    try {
      const cluster = this.cluster();
      const pods = (await cluster.listPods(null)).filter(isPsqlSessionPod);
      if (!pods.length) return 0;
      const ids = [
        ...new Set(pods.map((p) => p.metadata?.labels?.[PSQL_DATABASE_LABEL]).filter(Boolean))
      ] as string[];
      const rows = await this.prisma.database.findMany({
        where: { id: { in: ids } },
        select: { id: true }
      });
      const live = new Set(rows.map((r) => r.id));
      const now = Date.now();
      let removed = 0;
      for (const pod of pods) {
        const namespace = pod.metadata?.namespace;
        const name = pod.metadata?.name;
        if (!namespace || !name || !isStalePsqlPod(pod, now, live)) continue;
        await this.discard(cluster, namespace, name);
        removed += 1;
      }
      return removed;
    } catch (err) {
      this.logger.warn(`psql session sweep failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }
}
