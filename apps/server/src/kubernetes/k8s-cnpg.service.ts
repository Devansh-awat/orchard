import { Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException, OnApplicationBootstrap } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from './kubernetes.service';
import { cpuMilliToK8s, memoryBytesToK8s, parseMemory } from './quantity';

/**
 * All PostgreSQL flows: legacy single-pod Postgres (exec into shared cluster
 * pod), container-mode Postgres with pgBackRest, and CNPG operator-managed
 * clusters with backups, scheduled backups, public TLS reflection, and
 * MetalLB exposure. Owns the postgresql.cnpg.io CRD interactions.
 *
 * Shares the kubeconfig + a couple of generic helpers (createPVC) with the
 * core KubernetesService via injection; the moved bodies still reference
 * `this.kc`, `this.ensureKubeConfig()`, `this.createPVC()` — delegated below.
 */
@Injectable()
export class K8sCnpgService implements OnApplicationBootstrap {
  private readonly logger = new Logger(K8sCnpgService.name);

  // The operator reaches every instance's manager API (:8000) for status
  // probes and lifecycle management. Tenant namespaces default-deny ingress,
  // so each one carries an explicit allow for the operator; without it the
  // operator goes blind ("Instance Status Extraction Error") and any pod
  // disturbance becomes a restart it cannot manage (2026-07-20 incident).
  private readonly CNPG_OPERATOR_NAMESPACE =
    process.env.CNPG_OPERATOR_NAMESPACE || 'postgresql';

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async onApplicationBootstrap() {
    void this.backfillOperatorIngressPolicies();
  }

  async ensureCnpgOperatorIngress(namespace: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const policy = {
      apiVersion: 'cilium.io/v2',
      kind: 'CiliumNetworkPolicy',
      metadata: {
        name: 'allow-cnpg-operator',
        namespace,
        labels: { 'orchard.my/managed': 'true' },
      },
      spec: {
        endpointSelector: {
          matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }],
        },
        ingress: [
          {
            fromEndpoints: [
              {
                matchLabels: {
                  'app.kubernetes.io/name': 'cloudnative-pg',
                  'io.kubernetes.pod.namespace': this.CNPG_OPERATOR_NAMESPACE,
                },
              },
            ],
            toPorts: [{ ports: [{ port: '8000', protocol: 'TCP' }] }],
          },
        ],
      },
    };
    try {
      await customApi.createNamespacedCustomObject(
        'cilium.io', 'v2', namespace, 'ciliumnetworkpolicies', policy,
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 409) throw e;
    }
  }

  private async backfillOperatorIngressPolicies(): Promise<void> {
    try {
      this.ensureKubeConfig();
    } catch {
      return;
    }
    try {
      // Target only namespaces this server provisioned clusters into (from
      // its own database), never "any namespace with a cnpg cluster": a
      // cluster-wide sweep stamped the platform's own namespace and the
      // first policy selecting orchard-db's endpoints flipped them to
      // default-deny, cutting the server off from its database
      // (2026-07-20 incident, second half).
      // The platform's own database is deliberately NOT in this set even
      // when it is a cnpg cluster: its namespace belongs to the installer
      // (kubeops here), so its network policies must live there
      // declaratively. Stamping it from app code depends on an out-of-band
      // allow existing and breaks installs whose platform db has none.
      const rows = await this.prisma.database.findMany({
        where: { mode: 'cnpg', namespace: { not: null } },
        select: { namespace: true },
        distinct: ['namespace'],
      });
      const namespaces = new Set<string>(
        rows.map((r) => r.namespace).filter(Boolean) as string[],
      );
      for (const ns of namespaces) {
        try {
          await this.ensureCnpgOperatorIngress(ns);
        } catch (e: any) {
          this.logger.warn(`allow-cnpg-operator backfill failed for ${ns}: ${e?.message || e}`);
        }
      }
      if (namespaces.size > 0) {
        this.logger.log(`allow-cnpg-operator ensured in ${namespaces.size} namespaces`);
      }
    } catch (e: any) {
      this.logger.warn(`allow-cnpg-operator backfill skipped: ${e?.message || e}`);
    }
  }

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  private ensureKubeConfig() {
    this.kubernetes.ensureKubeConfig();
  }

  private createPVC(namespace: string, name: string, storageSize = '1Gi') {
    return this.kubernetes.createPVC(namespace, name, storageSize);
  }

  async updateCnpgClusterResources(
    namespace: string,
    clusterName: string,
    resources: { cpuMilli: number; memoryBytes: number },
  ) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const cpuStr = cpuMilliToK8s(resources.cpuMilli);
    const memStr = memoryBytesToK8s(resources.memoryBytes);
    const patch = [
      {
        op: 'replace',
        path: '/spec/resources',
        value: {
          requests: { cpu: cpuStr, memory: memStr },
          limits: { cpu: cpuStr, memory: memStr },
        },
      },
    ];
    try {
      await customApi.patchNamespacedCustomObject(
        'postgresql.cnpg.io',
        'v1',
        namespace,
        'clusters',
        clusterName,
        patch,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/json-patch+json' } },
      );
    } catch (err: any) {
      // If /spec/resources doesn't exist yet, use "add" op instead.
      if (err?.response?.body?.message?.includes('not found')) {
        const addPatch = [{ ...patch[0], op: 'add' }];
        await customApi.patchNamespacedCustomObject(
          'postgresql.cnpg.io',
          'v1',
          namespace,
          'clusters',
          clusterName,
          addPatch,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/json-patch+json' } },
        );
      } else {
        throw err;
      }
    }

    // CNPG performs a rolling update on resource changes only when the cluster has
    // a healthy primary — a single-instance cluster stuck in CrashLoopBackOff (the
    // exact case where users tend to bump resources) won't get rolled. Force-delete
    // the cluster's pods so the operator recreates them with the new spec.
    try {
      const { body: podList } = await coreApi.listNamespacedPod(
        namespace, undefined, undefined, undefined, undefined,
        `cnpg.io/cluster=${clusterName}`,
      );
      for (const pod of podList.items || []) {
        const name = pod.metadata?.name;
        if (!name) continue;
        try {
          await coreApi.deleteNamespacedPod(name, namespace);
        } catch { /* ignore — operator may already be recreating it */ }
      }
    } catch { /* ignore — pod listing/deletion is best-effort */ }
  }

  async expandCnpgClusterStorage(
    namespace: string,
    clusterName: string,
    newSize: string,
  ): Promise<{ previousSize: string; archivingFailure: string | null }> {
    this.ensureKubeConfig();
    if (!this.kc) {
      throw new ServiceUnavailableException('Kubernetes API not available');
    }
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const cluster: any = await customApi.getNamespacedCustomObject(
      'postgresql.cnpg.io',
      'v1',
      namespace,
      'clusters',
      clusterName,
    );
    const previousSize = String(cluster.body?.spec?.storage?.size || '').trim();
    if (!previousSize) {
      throw new BadRequestException('Cluster has no storage size configured');
    }

    const conditions: any[] = Array.isArray(cluster.body?.status?.conditions)
      ? cluster.body.status.conditions
      : [];
    const archiving = conditions.find((c) => c?.type === 'ContinuousArchiving');
    const archivingFailure =
      archiving && archiving.status === 'False'
        ? String(archiving.message || archiving.reason || 'WAL archiving is failing')
        : null;

    const previousBytes = parseMemory(previousSize);
    const newBytes = parseMemory(newSize);
    if (!newBytes) {
      throw new BadRequestException(`Invalid storage size: ${newSize}`);
    }
    if (newBytes <= previousBytes) {
      throw new BadRequestException(
        `Storage can only be expanded, never shrunk: requested ${newSize}, current size is ${previousSize}`,
      );
    }

    await customApi.patchNamespacedCustomObject(
      'postgresql.cnpg.io',
      'v1',
      namespace,
      'clusters',
      clusterName,
      [{ op: 'replace', path: '/spec/storage/size', value: newSize }],
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } },
    );

    return { previousSize, archivingFailure };
  }


  // ── PostgreSQL Database Management (via kubectl exec into CNPG pod) ──

  private readonly CNPG_NAMESPACE = 'postgresql';

  private readonly CNPG_POD = 'postgresql-cluster-1';

  private readonly CNPG_CONTAINER = 'postgres';

  private async execPsql(sql: string): Promise<string> {
    if (!this.kc) {
      throw new ServiceUnavailableException('Kubeconfig not loaded');
    }

    const exec = new k8s.Exec(this.kc);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    // Find the primary pod dynamically
    let podName = this.CNPG_POD;
    try {
      const { body: podList } = await coreApi.listNamespacedPod(
        this.CNPG_NAMESPACE,
        undefined, undefined, undefined, undefined,
        'cnpg.io/instanceRole=primary'
      );
      if (podList.items.length > 0) {
        podName = podList.items[0].metadata!.name!;
      }
    } catch {
      // Fall back to default pod name
    }

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      exec.exec(
        this.CNPG_NAMESPACE,
        podName,
        this.CNPG_CONTAINER,
        ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql],
        stdout,
        stderr,
        null,
        false,
        (status) => {
          const output = Buffer.concat(chunks).toString('utf-8').trim();
          const errOutput = Buffer.concat(errChunks).toString('utf-8').trim();

          if (status.status === 'Success') {
            resolve(output);
          } else {
            reject(new BadRequestException(
              `PostgreSQL command failed: ${errOutput || status.message || 'Unknown error'}`
            ));
          }
        },
      );
    });
  }

  async createPostgresDatabase(dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    // Defense-in-depth: identifiers are produced via formatSlug, but reject anything
    // that isn't a safe lowercase pg identifier before it ever lands in interpolated SQL.
    const SAFE_PG_IDENT = /^[a-z][a-z0-9_]{0,62}$/;
    if (!SAFE_PG_IDENT.test(dbUser)) throw new Error(`Refusing unsafe pg identifier: ${dbUser}`);
    if (!SAFE_PG_IDENT.test(dbName)) throw new Error(`Refusing unsafe pg identifier: ${dbName}`);

    console.log(`[K8s/PG] Creating database "${dbName}" with user "${dbUser}"`);

    // Create the role
    // NOTE: passwords are generated via crypto random hex upstream, so they cannot contain
    // a single quote; the .replace below is still applied as belt-and-braces.
    await this.execPsql(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${dbUser}') THEN CREATE ROLE "${dbUser}" LOGIN PASSWORD '${dbPassword.replace(/'/g, "''")}'; END IF; END $$;`
    );

    // Create the database
    // Can't use IF NOT EXISTS in DO block for CREATE DATABASE, so check first
    const exists = await this.execPsql(
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`
    );

    if (!exists) {
      await this.execPsql(`CREATE DATABASE "${dbName}" OWNER "${dbUser}";`);
    } else {
      throw new BadRequestException(`Database "${dbName}" already exists`);
    }

    // Grant privileges
    await this.execPsql(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}";`);

    console.log(`[K8s/PG] Database "${dbName}" created successfully`);
  }

  async deletePostgresDatabase(dbName: string, dbUser: string): Promise<void> {
    // Defense-in-depth: same identifier whitelist as createPostgresDatabase.
    const SAFE_PG_IDENT = /^[a-z][a-z0-9_]{0,62}$/;
    if (!SAFE_PG_IDENT.test(dbUser)) throw new Error(`Refusing unsafe pg identifier: ${dbUser}`);
    if (!SAFE_PG_IDENT.test(dbName)) throw new Error(`Refusing unsafe pg identifier: ${dbName}`);

    console.log(`[K8s/PG] Deleting database "${dbName}" and user "${dbUser}"`);

    // Terminate existing connections
    await this.execPsql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`
    );

    // Drop database and role
    const dbExists = await this.execPsql(
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`
    );
    if (dbExists) {
      await this.execPsql(`DROP DATABASE "${dbName}";`);
    }

    const roleExists = await this.execPsql(
      `SELECT 1 FROM pg_roles WHERE rolname = '${dbUser}';`
    );
    if (roleExists) {
      await this.execPsql(`DROP ROLE "${dbUser}";`);
    }

    console.log(`[K8s/PG] Database "${dbName}" and user "${dbUser}" deleted`);
  }

  async getPostgresDatabaseStatus(dbName: string): Promise<{ exists: boolean; size?: string; connections?: number }> {
    const SAFE_PG_IDENT = /^[a-z][a-z0-9_]{0,62}$/;
    if (!SAFE_PG_IDENT.test(dbName)) throw new Error(`Refusing unsafe pg identifier: ${dbName}`);
    try {
      const sizeResult = await this.execPsql(
        `SELECT pg_size_pretty(pg_database_size('${dbName}'));`
      );
      const connResult = await this.execPsql(
        `SELECT count(*) FROM pg_stat_activity WHERE datname = '${dbName}';`
      );
      return {
        exists: true,
        size: sizeResult || '0 bytes',
        connections: parseInt(connResult, 10) || 0,
      };
    } catch {
      return { exists: false };
    }
  }

  // ── Container-mode Postgres with pgBackRest ──

  private pgBackRestStanza(dbName: string): string {
    return dbName.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private buildPgBackRestConf(opts: {
    stanza: string;
    r2Endpoint: string;
    r2Bucket: string;
    r2Region: string;
  }): string {
    const host = opts.r2Endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return [
      '[global]',
      'repo1-type=s3',
      `repo1-s3-bucket=${opts.r2Bucket}`,
      `repo1-s3-endpoint=${host}`,
      `repo1-s3-region=${opts.r2Region || 'auto'}`,
      'repo1-s3-uri-style=path',
      `repo1-path=/pgbackrest/${opts.stanza}`,
      'repo1-retention-full=7',
      'repo1-cipher-type=none',
      'process-max=2',
      'log-level-console=info',
      'start-fast=y',
      '',
      `[${opts.stanza}]`,
      'pg1-path=/var/lib/postgresql/data/pgdata',
      'pg1-port=5432',
      'pg1-user=postgres',
      '',
    ].join('\n');
  }

  async createPostgresContainer(options: {
    namespace: string;
    name: string;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    storageSize?: string;
    r2?: { endpoint: string; bucket: string; region?: string; accessKey: string; secretKey: string };
    resources?: { cpuMilli: number; memoryBytes: number };
  }): Promise<{ host: string; port: number }> {
    this.ensureKubeConfig();

    const ns = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    if (!ns) throw new BadRequestException('Namespace is required');
    if (!name) throw new BadRequestException('Name is required');

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    const stanza = this.pgBackRestStanza(options.dbName);
    const labels = {
      'app.kubernetes.io/name': name,
      'app.kubernetes.io/component': 'postgres',
      'app.kubernetes.io/managed-by': 'orchard',
    };
    const selectorLabels = { 'app.kubernetes.io/name': name };

    const secretName = `${name}-pg`;
    const secretData: Record<string, string> = {
      'POSTGRES_DB': Buffer.from(options.dbName).toString('base64'),
      'POSTGRES_USER': Buffer.from(options.dbUser).toString('base64'),
      'POSTGRES_PASSWORD': Buffer.from(options.dbPassword).toString('base64'),
    };
    if (options.r2) {
      secretData['R2_ENDPOINT'] = Buffer.from(options.r2.endpoint).toString('base64');
      secretData['R2_BUCKET'] = Buffer.from(options.r2.bucket).toString('base64');
      secretData['R2_REGION'] = Buffer.from(options.r2.region || 'auto').toString('base64');
      secretData['R2_ACCESS_KEY'] = Buffer.from(options.r2.accessKey).toString('base64');
      secretData['R2_SECRET_KEY'] = Buffer.from(options.r2.secretKey).toString('base64');
    }

    try {
      await coreApi.readNamespacedSecret(secretName, ns);
      await coreApi.replaceNamespacedSecret(secretName, ns, {
        metadata: { name: secretName, namespace: ns, labels },
        type: 'Opaque',
        data: secretData,
      });
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedSecret(ns, {
          metadata: { name: secretName, namespace: ns, labels },
          type: 'Opaque',
          data: secretData,
        });
      } else {
        throw e;
      }
    }

    const pgbackrestConf = options.r2
      ? this.buildPgBackRestConf({
          stanza,
          r2Endpoint: options.r2.endpoint,
          r2Bucket: options.r2.bucket,
          r2Region: options.r2.region || 'auto',
        })
      : '';

    const cmName = `${name}-pgbackrest`;
    const cmData = {
      'pgbackrest.conf': pgbackrestConf,
      'postgresql.auto.conf.snippet': [
        "archive_mode = 'on'",
        `archive_command = 'pgbackrest --stanza=${stanza} archive-push %p'`,
        'archive_timeout = 60',
        'max_wal_senders = 3',
        'wal_level = replica',
        '',
      ].join('\n'),
      'init.sh': [
        '#!/bin/sh',
        'set -e',
        'mkdir -p /var/lib/postgresql/data/pgdata',
        "if [ -f /var/lib/postgresql/data/pgdata/postgresql.conf ]; then",
        "  grep -q 'archive_mode' /var/lib/postgresql/data/pgdata/postgresql.conf || cat /etc/pgbackrest-config/postgresql.auto.conf.snippet >> /var/lib/postgresql/data/pgdata/postgresql.conf",
        'fi',
        '',
      ].join('\n'),
    };

    try {
      await coreApi.readNamespacedConfigMap(cmName, ns);
      await coreApi.replaceNamespacedConfigMap(cmName, ns, {
        metadata: { name: cmName, namespace: ns, labels },
        data: cmData,
      });
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedConfigMap(ns, {
          metadata: { name: cmName, namespace: ns, labels },
          data: cmData,
        });
      } else {
        throw e;
      }
    }

    const dataPvc = `${name}-data`;
    await this.createPVC(ns, dataPvc, options.storageSize || '1Gi');

    const envFromSecret: k8s.V1EnvVar[] = [
      { name: 'POSTGRES_DB', valueFrom: { secretKeyRef: { name: secretName, key: 'POSTGRES_DB' } } },
      { name: 'POSTGRES_USER', valueFrom: { secretKeyRef: { name: secretName, key: 'POSTGRES_USER' } } },
      { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: secretName, key: 'POSTGRES_PASSWORD' } } },
      { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
    ];

    const pgbackrestEnv: k8s.V1EnvVar[] = options.r2
      ? [
          { name: 'PGBACKREST_REPO1_S3_KEY', valueFrom: { secretKeyRef: { name: secretName, key: 'R2_ACCESS_KEY' } } },
          { name: 'PGBACKREST_REPO1_S3_KEY_SECRET', valueFrom: { secretKeyRef: { name: secretName, key: 'R2_SECRET_KEY' } } },
        ]
      : [];

    const postgresContainer: k8s.V1Container = {
      name: 'postgres',
      image: 'postgres:17',
      imagePullPolicy: 'IfNotPresent',
      ports: [{ name: 'postgres', containerPort: 5432, protocol: 'TCP' }],
      env: [
        ...envFromSecret,
        ...(options.r2 ? pgbackrestEnv : []),
      ],
      args: options.r2
        ? [
            'postgres',
            '-c', 'archive_mode=on',
            '-c', `archive_command=/opt/pgbackrest/pgbackrest --stanza=${stanza} --config=/etc/pgbackrest/pgbackrest.conf archive-push %p`,
            '-c', 'archive_timeout=60',
            '-c', 'max_wal_senders=3',
            '-c', 'wal_level=replica',
          ]
        : undefined,
      volumeMounts: [
        { name: 'data', mountPath: '/var/lib/postgresql/data' },
        { name: 'pgbackrest-config', mountPath: '/etc/pgbackrest-config' },
        { name: 'pgbackrest-conf', mountPath: '/etc/pgbackrest' },
        ...(options.r2 ? [{ name: 'pgbackrest-bin', mountPath: '/opt/pgbackrest' }] : []),
      ],
      readinessProbe: {
        exec: { command: ['pg_isready', '-U', options.dbUser, '-d', options.dbName] },
        periodSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 6,
      },
      livenessProbe: {
        exec: { command: ['pg_isready', '-U', options.dbUser, '-d', options.dbName] },
        periodSeconds: 30,
        timeoutSeconds: 5,
        failureThreshold: 6,
      },
    };

    if (options.resources) {
      const cpuStr = cpuMilliToK8s(options.resources.cpuMilli);
      const memStr = memoryBytesToK8s(options.resources.memoryBytes);
      postgresContainer.resources = {
        requests: { cpu: cpuStr, memory: memStr },
        limits: { cpu: cpuStr, memory: memStr },
      };
    }

    const pgbackrestContainer: k8s.V1Container = {
      name: 'pgbackrest',
      image: 'woblerr/pgbackrest:2.56.0-alpine',
      imagePullPolicy: 'IfNotPresent',
      command: ['/bin/sh', '-c', 'cp /etc/pgbackrest-config/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf 2>/dev/null || true; sleep infinity'],
      env: [...envFromSecret, ...pgbackrestEnv],
      volumeMounts: [
        { name: 'data', mountPath: '/var/lib/postgresql/data' },
        { name: 'pgbackrest-config', mountPath: '/etc/pgbackrest-config' },
        { name: 'pgbackrest-conf', mountPath: '/etc/pgbackrest' },
      ],
    };

    const volumes: k8s.V1Volume[] = [
      { name: 'data', persistentVolumeClaim: { claimName: dataPvc } },
      { name: 'pgbackrest-config', configMap: { name: cmName, defaultMode: 0o755 } },
      { name: 'pgbackrest-conf', emptyDir: {} },
      ...(options.r2 ? [{ name: 'pgbackrest-bin', emptyDir: {} }] : []),
    ];

    const initContainers: k8s.V1Container[] = options.r2
      ? [
          {
            name: 'pgbackrest-install',
            image: 'postgres:17',
            imagePullPolicy: 'IfNotPresent',
            command: ['/bin/bash', '-c', [
              'set -e',
              'if [ -x /shared/pgbackrest ]; then echo "pgbackrest already installed"; exit 0; fi',
              'echo "Installing pgbackrest into /shared..."',
              'export DEBIAN_FRONTEND=noninteractive',
              'apt-get update -qq',
              'apt-get install -y --no-install-recommends pgbackrest',
              'cp "$(command -v pgbackrest)" /shared/pgbackrest',
              'chmod 0755 /shared/pgbackrest',
              'echo "done"',
            ].join(' && ')],
            volumeMounts: [{ name: 'pgbackrest-bin', mountPath: '/shared' }],
          },
        ]
      : [];

    const deploymentBody: k8s.V1Deployment = {
      metadata: { name, namespace: ns, labels },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels },
          spec: {
            initContainers: initContainers.length ? initContainers : undefined,
            containers: options.r2 ? [postgresContainer, pgbackrestContainer] : [postgresContainer],
            volumes,
          },
        },
      },
    };

    try {
      await appsApi.readNamespacedDeployment(name, ns);
      await appsApi.replaceNamespacedDeployment(name, ns, deploymentBody);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await appsApi.createNamespacedDeployment(ns, deploymentBody);
      } else {
        throw e;
      }
    }

    const serviceBody: k8s.V1Service = {
      metadata: { name, namespace: ns, labels },
      spec: {
        type: 'ClusterIP',
        selector: selectorLabels,
        ports: [{ name: 'postgres', port: 5432, targetPort: 5432, protocol: 'TCP' }],
      },
    };
    try {
      await coreApi.readNamespacedService(name, ns);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(ns, serviceBody);
      } else {
        throw e;
      }
    }

    return { host: `${name}.${ns}.svc.cluster.local`, port: 5432 };
  }

  async deletePostgresContainer(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();
    const ns = String(namespace || '').trim();
    const n = String(name || '').trim();
    if (!ns || !n) return;

    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const ignore404 = async (p: Promise<any>) => {
      try { await p; } catch (e: any) { if (e.response?.statusCode !== 404) throw e; }
    };

    await ignore404(appsApi.deleteNamespacedDeployment(n, ns));
    await ignore404(coreApi.deleteNamespacedService(n, ns));
    await ignore404(coreApi.deleteNamespacedSecret(`${n}-pg`, ns));
    await ignore404(coreApi.deleteNamespacedConfigMap(`${n}-pgbackrest`, ns));
    await ignore404(coreApi.deleteNamespacedPersistentVolumeClaim(`${n}-data`, ns));
    // Legacy repo PVC from earlier versions; safe to ignore if it doesn't exist.
    await ignore404(coreApi.deleteNamespacedPersistentVolumeClaim(`${n}-pgbackrest`, ns));
  }

  // Public wrapper so other modules (e.g. the MCP exec tool, the deployments
  // controller) can run a one-shot command in a pod without going through the
  // websocket terminal gateway. Returns stdout/stderr/success — no streaming.
  async runExec(
    namespace: string,
    pod: string,
    cmd: string[],
    container?: string,
  ): Promise<{ stdout: string; stderr: string; success: boolean; container: string }> {
    this.ensureKubeConfig();

    let targetContainer = container?.trim() || '';
    if (!targetContainer) {
      // Default to the first container in the pod spec; the pod terminal
      // gateway uses the same convention.
      try {
        const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        const podSpec = await coreApi.readNamespacedPod(pod, namespace);
        targetContainer = podSpec.body.spec?.containers?.[0]?.name || '';
      } catch (error) {
        throw new NotFoundException({
          error: 'Pod not found',
          message: `Could not resolve pod ${pod} in ${namespace}: ${error.message}`,
        });
      }
    }
    if (!targetContainer) {
      throw new BadRequestException('Pod has no containers to exec into');
    }

    const result = await this.execInPod(namespace, pod, targetContainer, cmd);
    return { ...result, container: targetContainer };
  }

  private async execInPod(namespace: string, pod: string, container: string, cmd: string[]): Promise<{ stdout: string; stderr: string; success: boolean }> {
    this.ensureKubeConfig();
    const exec = new k8s.Exec(this.kc);
    console.log(`[K8s/exec] ns=${namespace} pod=${pod} container=${container} cmd=${JSON.stringify(cmd)}`);
    return new Promise((resolve) => {
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on('data', (c: Buffer) => outChunks.push(c));
      stderr.on('data', (c: Buffer) => errChunks.push(c));
      exec.exec(namespace, pod, container, cmd, stdout, stderr, null, false, (status) => {
        const stdoutStr = Buffer.concat(outChunks).toString('utf-8');
        const stderrStr = Buffer.concat(errChunks).toString('utf-8');
        const success = status.status === 'Success';
        console.log(`[K8s/exec] result ns=${namespace} pod=${pod} container=${container} success=${success}`);
        if (stdoutStr) console.log(`[K8s/exec] stdout:\n${stdoutStr}`);
        if (stderrStr) console.log(`[K8s/exec] stderr:\n${stderrStr}`);
        if (!success) console.log(`[K8s/exec] status: ${JSON.stringify(status)}`);
        resolve({ stdout: stdoutStr, stderr: stderrStr, success });
      }).catch((err: any) => {
        const msg = err?.message || String(err);
        console.error(`[K8s/exec] FAILED ns=${namespace} pod=${pod} container=${container}: ${msg}`);
        if (err?.body) console.error(`[K8s/exec] body:`, err.body);
        resolve({
          stdout: '',
          stderr: `exec error: ${msg}`,
          success: false,
        });
      });
    });
  }

  private async findPostgresPod(namespace: string, name: string): Promise<string> {
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listNamespacedPod(
      namespace, undefined, undefined, undefined, undefined,
      `app.kubernetes.io/name=${name}`
    );
    const pod = body.items.find((p) => p.status?.phase === 'Running') || body.items[0];
    if (!pod?.metadata?.name) throw new NotFoundException(`No pod found for database ${name}`);
    return pod.metadata.name;
  }

  async initPgBackRestStanza(namespace: string, name: string, dbName: string): Promise<void> {
    const pod = await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    await this.execInPod(namespace, pod, 'pgbackrest', ['pgbackrest', `--stanza=${stanza}`, 'stanza-create']);
  }

  async runPostgresBackup(namespace: string, name: string, dbName: string, type: 'full' | 'diff' | 'incr' = 'full'): Promise<{ success: boolean; output: string }> {
    const pod = await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    console.log(`[PG/backup] Starting ${type} backup stanza=${stanza} pod=${pod}`);

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body: podBody } = await coreApi.readNamespacedPod(pod, namespace);
    const containers = (podBody.spec?.containers || []).map((c) => c.name);
    console.log(`[PG/backup] pod containers: ${containers.join(', ')}`);
    if (!containers.includes('pgbackrest')) {
      const msg = `Pod ${pod} has no "pgbackrest" sidecar container (found: ${containers.join(', ')}). This database was likely created before R2 was configured — recreate it or restart it to pick up the sidecar.`;
      console.error(`[PG/backup] ${msg}`);
      return { success: false, output: msg };
    }

    const stanzaResult = await this.execInPod(namespace, pod, 'pgbackrest', ['pgbackrest', `--stanza=${stanza}`, 'stanza-create']);
    console.log(`[PG/backup] stanza-create success=${stanzaResult.success}`);

    const result = await this.execInPod(namespace, pod, 'pgbackrest', ['pgbackrest', `--stanza=${stanza}`, `--type=${type}`, 'backup']);
    console.log(`[PG/backup] backup success=${result.success}`);
    return { success: result.success, output: (result.stdout + result.stderr) || 'no output' };
  }

  async listPostgresBackups(namespace: string, name: string, dbName: string): Promise<any[]> {
    const pod = await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    const result = await this.execInPod(namespace, pod, 'pgbackrest', ['pgbackrest', `--stanza=${stanza}`, '--output=json', 'info']);
    if (!result.success) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) && parsed[0]?.backup ? parsed[0].backup : [];
    } catch {
      return [];
    }
  }

  async restorePostgresBackup(namespace: string, name: string, dbName: string, backupLabel?: string): Promise<{ success: boolean; output: string }> {
    await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    await appsApi.patchNamespacedDeploymentScale(
      name, namespace, { spec: { replicas: 0 } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    await new Promise((r) => { setTimeout(r, 5000); });

    await appsApi.patchNamespacedDeploymentScale(
      name, namespace, { spec: { replicas: 1 } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    let newPod = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => { setTimeout(r, 3000); });
      try {
        newPod = await this.findPostgresPod(namespace, name);
        break;
      } catch {}
    }
    if (!newPod) throw new ServiceUnavailableException('Postgres pod did not come back up for restore');

    const args = ['pgbackrest', `--stanza=${stanza}`, '--delta'];
    if (backupLabel) args.push(`--set=${backupLabel}`);
    args.push('restore');
    const result = await this.execInPod(namespace, newPod, 'pgbackrest', args);
    return { success: result.success, output: result.stdout + result.stderr };
  }

  async getPostgresContainerStatus(namespace: string, name: string, dbName?: string, dbUser?: string): Promise<{ exists: boolean; ready?: boolean; phase?: string; replicas?: number; readyReplicas?: number; size?: string; connections?: number; restartCount?: number; message?: string }> {
    this.ensureKubeConfig();
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      const { body: dep } = await appsApi.readNamespacedDeployment(name, namespace);
      const replicas = dep.spec?.replicas ?? 0;
      const readyReplicas = dep.status?.readyReplicas ?? 0;
      const ready = readyReplicas > 0;

      let phase: string | undefined;
      let restartCount = 0;
      let message: string | undefined;
      try {
        const { body: podList } = await coreApi.listNamespacedPod(
          namespace, undefined, undefined, undefined, undefined,
          `app.kubernetes.io/name=${name}`
        );
        const pod = podList.items[0];
        if (pod) {
          phase = pod.status?.phase;
          const container = pod.status?.containerStatuses?.find((c) => c.name === 'postgres');
          if (container) {
            restartCount = container.restartCount || 0;
            if (container.state?.waiting) {
              message = container.state.waiting.reason;
              if (container.state.waiting.message) phase = 'Waiting';
            } else if (container.state?.terminated) {
              message = container.state.terminated.reason;
            }
          }
        } else {
          phase = 'Pending';
          message = 'No pod found';
        }
      } catch {}

      let size: string | undefined;
      let connections: number | undefined;
      if (ready && dbName && dbUser) {
        try {
          const pod = await this.findPostgresPod(namespace, name);
          // Pass dbName via a psql variable (`-v name=value`) and reference
          // it as `:'dbname'`, which psql client-side-quotes as a
          // SQL string literal. This avoids string-interpolating the
          // database name into SQL even though dbName originates from a
          // DB row (defence in depth — if a future code path lets users
          // pick the name, the SQL stays safe).
          const exec = async (sql: string): Promise<string> => {
            const r = await this.execInPod(namespace, pod, 'postgres', [
              'psql', '-U', dbUser, '-d', dbName,
              '-v', `dbname=${dbName}`,
              '-t', '-A', '-c', sql,
            ]);
            return r.stdout.trim();
          };
          size = await exec(`SELECT pg_size_pretty(pg_database_size(:'dbname'));`);
          const connRaw = await exec(`SELECT count(*) FROM pg_stat_activity WHERE datname = :'dbname';`);
          connections = parseInt(connRaw, 10) || 0;
        } catch {}
      }

      return { exists: true, ready, phase, replicas, readyReplicas, size, connections, restartCount, message };
    } catch {
      return { exists: false };
    }
  }


  // ── CNPG (CloudNativePG) Cluster management ──

  private readonly CNPG_GROUP = 'postgresql.cnpg.io';

  private readonly CNPG_VERSION = 'v1';

  private readonly CNPG_PLURAL = 'clusters';

  private readonly CNPG_BACKUP_PLURAL = 'backups';

  private readonly CNPG_SCHEDULED_BACKUP_PLURAL = 'scheduledbackups';

  private buildAppSecretName(clusterName: string): string {
    return `${clusterName}-app`;
  }

  async createCnpgCluster(options: {
    namespace: string;
    clusterName: string;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    storageSize?: string;
    parameters?: Record<string, string>;
    sharedPreloadLibraries?: string[];
    imageName?: string;
    r2?: { endpoint: string; bucket: string; region?: string; accessKey: string; secretKey: string };
    resources?: { cpuMilli: number; memoryBytes: number };
    importFrom?: {
      host: string;
      port?: number;
      user: string;
      password: string;
      database: string;
      sslMode?: string;
    };
  }): Promise<{ host: string; port: number }> {
    this.ensureKubeConfig();
    await this.ensureCnpgOperatorIngress(
      String(options.namespace || '').trim(),
    ).catch((e) => {
      this.logger.warn(`allow-cnpg-operator ensure failed: ${e?.message || e}`);
    });
    const ns = options.namespace.trim();
    const name = options.clusterName.trim();
    if (!ns || !name) throw new BadRequestException('namespace and clusterName required');

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const labels = {
      'app.kubernetes.io/name': name,
      'app.kubernetes.io/component': 'postgres',
      'app.kubernetes.io/managed-by': 'orchard',
    };

    // App-user credential secret — referenced by the Cluster for initdb bootstrap.
    const appSecretName = this.buildAppSecretName(name);
    const appSecretData = {
      username: Buffer.from(options.dbUser).toString('base64'),
      password: Buffer.from(options.dbPassword).toString('base64'),
    };
    await this.upsertSecret(coreApi, ns, appSecretName, 'kubernetes.io/basic-auth', appSecretData, labels);

    // R2 credentials secret (if backups configured).
    let r2SecretName: string | undefined;
    if (options.r2) {
      r2SecretName = `${name}-r2`;
      const r2SecretData = {
        ACCESS_KEY_ID: Buffer.from(options.r2.accessKey).toString('base64'),
        ACCESS_SECRET_KEY: Buffer.from(options.r2.secretKey).toString('base64'),
      };
      await this.upsertSecret(coreApi, ns, r2SecretName, 'Opaque', r2SecretData, labels);
    }

    const clusterSpec: any = {
      instances: 1,
      imageName: options.imageName || 'ghcr.io/cloudnative-pg/postgresql:17',
      primaryUpdateStrategy: 'unsupervised',
      storage: {
        size: options.storageSize || '1Gi',
        storageClass: process.env.K8S_STORAGE_CLASS || 'longhorn',
      },
      bootstrap: {
        initdb: {
          database: options.dbName,
          owner: options.dbUser,
          secret: { name: appSecretName },
        },
      },
      postgresql: {
        parameters: {
          max_connections: '100',
          shared_buffers: '128MB',
          ...options.parameters,
        },
        ...(options.sharedPreloadLibraries && options.sharedPreloadLibraries.length > 0
          ? { shared_preload_libraries: options.sharedPreloadLibraries }
          : {}),
      },
      enableSuperuserAccess: true,
    };

    if (options.resources) {
      const cpuStr = cpuMilliToK8s(options.resources.cpuMilli);
      const memStr = memoryBytesToK8s(options.resources.memoryBytes);
      clusterSpec.resources = {
        requests: { cpu: cpuStr, memory: memStr },
        limits: { cpu: cpuStr, memory: memStr },
      };
    }

    if (options.importFrom) {
      const importSecretName = `${name}-import-source`;
      await this.upsertSecret(coreApi, ns, importSecretName, 'Opaque', {
        password: Buffer.from(options.importFrom.password).toString('base64'),
      }, labels);

      const sourceName = 'import-source';
      clusterSpec.externalClusters = [
        {
          name: sourceName,
          connectionParameters: {
            host: options.importFrom.host,
            port: String(options.importFrom.port || 5432),
            user: options.importFrom.user,
            dbname: options.importFrom.database,
            sslmode: options.importFrom.sslMode || 'prefer',
          },
          password: { name: importSecretName, key: 'password' },
        },
      ];
      clusterSpec.bootstrap.initdb.import = {
        type: 'microservice',
        databases: [options.importFrom.database],
        source: { externalCluster: sourceName },
        // pg_restore never runs ANALYZE, so without this the planner has zero
        // statistics until autoanalyze catches up and every query misplans.
        postImportApplicationSQL: ['ANALYZE'],
      };
    }

    if (options.r2 && r2SecretName) {
      // Preserve the scheme from the configured endpoint — when r2-proxy is
      // enabled the endpoint is http:// (plaintext, in-cluster); when going
      // direct to R2 it's https://. Stripping then re-prefixing https broke
      // the proxy path.
      const endpointRaw = options.r2.endpoint.replace(/\/$/, '');
      const endpointURL = /^https?:\/\//.test(endpointRaw) ? endpointRaw : `https://${endpointRaw}`;
      clusterSpec.backup = {
        barmanObjectStore: {
          destinationPath: `s3://${options.r2.bucket}/${ns}/${name}`,
          endpointURL,
          s3Credentials: {
            accessKeyId: { name: r2SecretName, key: 'ACCESS_KEY_ID' },
            secretAccessKey: { name: r2SecretName, key: 'ACCESS_SECRET_KEY' },
          },
          wal: { compression: 'gzip' },
          data: { compression: 'gzip' },
        },
        retentionPolicy: '30d',
      };
    }

    const clusterBody: any = {
      apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
      kind: 'Cluster',
      metadata: { name, namespace: ns, labels },
      spec: clusterSpec,
    };

    try {
      await customApi.getNamespacedCustomObject(this.CNPG_GROUP, this.CNPG_VERSION, ns, this.CNPG_PLURAL, name);
      await customApi.replaceNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, ns, this.CNPG_PLURAL, name, clusterBody,
      );
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await customApi.createNamespacedCustomObject(
          this.CNPG_GROUP, this.CNPG_VERSION, ns, this.CNPG_PLURAL, clusterBody,
        );
      } else {
        throw e;
      }
    }

    // Service name is <cluster>-rw (read/write primary). DNS takes a few seconds.
    return { host: `${name}-rw.${ns}.svc.cluster.local`, port: 5432 };
  }

  private async upsertSecret(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    name: string,
    type: string,
    data: Record<string, string>,
    labels: Record<string, string>,
  ) {
    const body: k8s.V1Secret = {
      metadata: { name, namespace, labels },
      type,
      data,
    };
    try {
      await coreApi.readNamespacedSecret(name, namespace);
      await coreApi.replaceNamespacedSecret(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedSecret(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deleteCnpgCluster(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const ns = namespace.trim();
    const name = clusterName.trim();
    if (!ns || !name) return;

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const ignore404 = async (p: Promise<any>) => {
      try { await p; } catch (e: any) { if (e.response?.statusCode !== 404) throw e; }
    };

    await ignore404(customApi.deleteNamespacedCustomObject(
      this.CNPG_GROUP, this.CNPG_VERSION, ns, this.CNPG_PLURAL, name,
    ));
    await ignore404(coreApi.deleteNamespacedSecret(this.buildAppSecretName(name), ns));
    await ignore404(coreApi.deleteNamespacedSecret(`${name}-r2`, ns));
    await ignore404(coreApi.deleteNamespacedSecret(`${name}-import-source`, ns));
  }

  async getCnpgClusterStatus(namespace: string, clusterName: string, dbName?: string): Promise<any> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_PLURAL, clusterName,
      );
      const cluster: any = body;
      const phase: string = cluster.status?.phase || 'Unknown';
      const readyInstances: number = cluster.status?.readyInstances || 0;
      const instances: number = cluster.status?.instances || cluster.spec?.instances || 1;
      // Prefer quantitative readiness over phase strings, which can include noisy transient messages
      // like "Instance Status Extraction Error: HTTP communication issue" during pod startup.
      const ready = readyInstances >= instances && readyInstances > 0;

      // Surface restart count and last-termination reason from the postgres container
      // across all instance pods. The cluster phase / readyInstances alone hide
      // OOMKill cycles when the pod is currently in `running` state between crashes.
      let restartCount = 0;
      let lastTerminationReason: string | undefined;
      let lastTerminationExitCode: number | undefined;
      let lastTerminationAt: string | undefined;
      let currentWaitingReason: string | undefined;
      let currentRunningSinceMs: number | undefined;
      let currentReady = false;
      try {
        const { body: podList } = await coreApi.listNamespacedPod(
          namespace, undefined, undefined, undefined, undefined,
          `cnpg.io/cluster=${clusterName}`,
        );
        for (const pod of podList.items || []) {
          const container = pod.status?.containerStatuses?.find((c) => c.name === 'postgres');
          if (!container) continue;
          restartCount += container.restartCount || 0;
          const lastTerm = (container as any).lastState?.terminated;
          if (lastTerm?.reason) {
            // Keep the most recent termination across pods
            const at: string | undefined = lastTerm.finishedAt;
            if (!lastTerminationAt || (at && at > lastTerminationAt)) {
              lastTerminationReason = lastTerm.reason;
              lastTerminationExitCode = lastTerm.exitCode;
              lastTerminationAt = at;
            }
          }
          if (container.state?.waiting?.reason) {
            currentWaitingReason = container.state.waiting.reason;
          }
          const runningSince = (container as any).state?.running?.startedAt;
          if (runningSince) {
            const t = Date.parse(runningSince);
            if (!Number.isNaN(t) && (currentRunningSinceMs === undefined || t > currentRunningSinceMs)) {
              currentRunningSinceMs = t;
            }
          }
          if (container.ready) currentReady = true;
        }
      } catch { /* ignore — pod listing is best-effort */ }

      // Synthesize a `message` so the existing frontend liveStatus.message path
      // surfaces OOMKilled / CrashLoopBackOff even when the container is currently running.
      // Historical terminations are only surfaced if they're still "fresh" — once the
      // container has been running cleanly for a while (e.g. after a memory bump),
      // we stop nagging about the old OOM.
      const STALE_TERMINATION_MS = 10 * 60 * 1000; // 10 minutes of clean runtime = recovered
      const runningCleanlyForMs = currentReady && currentRunningSinceMs
        ? Date.now() - currentRunningSinceMs
        : 0;
      const terminationIsStale = runningCleanlyForMs > STALE_TERMINATION_MS;

      let message: string | undefined;
      if (currentWaitingReason) {
        message = currentWaitingReason; // e.g. "CrashLoopBackOff"
      } else if (
        lastTerminationReason &&
        lastTerminationReason !== 'Completed' &&
        !terminationIsStale
      ) {
        // e.g. "OOMKilled" — only flag if we haven't yet proven the issue is gone
        message = lastTerminationReason;
      }

      // Same psql-variable pattern as getPostgresContainerStatus: pass dbName
      // via `-v` and reference it as `:'dbname'` so it's client-side-quoted
      // instead of interpolated into SQL. Best-effort — a failed exec just
      // leaves size/connections undefined.
      let size: string | undefined;
      let connections: number | undefined;
      const currentPrimary: string | undefined = cluster.status?.currentPrimary;
      if (ready && dbName && currentPrimary) {
        try {
          const exec = async (sql: string): Promise<string> => {
            const r = await this.execInPod(namespace, currentPrimary, 'postgres', [
              'psql', '-U', 'postgres',
              '-v', `dbname=${dbName}`,
              '-t', '-A', '-c', sql,
            ]);
            return r.stdout.trim();
          };
          size = await exec(`SELECT pg_size_pretty(pg_database_size(:'dbname'));`);
          const connRaw = await exec(`SELECT count(*) FROM pg_stat_activity WHERE datname = :'dbname';`);
          connections = parseInt(connRaw, 10) || 0;
        } catch { /* best-effort */ }
      }

      return {
        exists: true,
        phase,
        ready,
        readyReplicas: readyInstances,
        replicas: instances,
        currentPrimary: cluster.status?.currentPrimary,
        size,
        connections,
        conditions: cluster.status?.conditions || [],
        restartCount,
        message,
        lastTerminationReason,
        lastTerminationExitCode,
        lastTerminationAt,
      };
    } catch (e: any) {
      if (e.response?.statusCode === 404) return { exists: false };
      throw e;
    }
  }

  // Detailed provisioning view for the CNPG cluster: PVC, instance pod, optional
  // import job pod, conditions, and recent warning events. Used by the database
  // page to show a step-by-step "provisioning" experience while the cluster is
  // coming up, and to surface migration errors that previously only appeared via
  // `kubectl logs`.
  async getCnpgProvisioningStatus(
    namespace: string,
    clusterName: string,
    opts?: { fetchImportLogs?: boolean },
  ): Promise<any> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    let cluster: any = null;
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_PLURAL, clusterName,
      );
      cluster = body;
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }

    const hasImport = !!cluster?.spec?.bootstrap?.initdb?.import;
    const phase: string | undefined = cluster?.status?.phase;
    const readyInstances: number = cluster?.status?.readyInstances || 0;
    const instances: number = cluster?.status?.instances || cluster?.spec?.instances || 1;
    const ready = readyInstances >= instances && readyInstances > 0;

    let pods: any[] = [];
    try {
      const { body: podList } = await coreApi.listNamespacedPod(
        namespace, undefined, undefined, undefined, undefined,
        `cnpg.io/cluster=${clusterName}`,
      );
      pods = podList.items || [];
    } catch { /* ignore */ }

    const importPod = pods.find((p) => {
      const labels = p.metadata?.labels || {};
      return labels['cnpg.io/jobRole'] === 'import' ||
        labels['cnpg.io/jobRole'] === 'full-recovery' ||
        /-import-\d+$/.test(p.metadata?.name || '');
    });
    const instancePod = pods.find((p) => {
      const labels = p.metadata?.labels || {};
      return labels['cnpg.io/instanceRole'] === 'primary' ||
        labels['cnpg.io/instanceRole'] === 'replica' ||
        labels['role'] === 'primary' ||
        /-\d+$/.test(p.metadata?.name || '');
    }) || pods.find((p) => p !== importPod);

    // PVC: CNPG provisions `<cluster>-1` for the first instance.
    let pvc: { exists: boolean; bound: boolean; phase?: string } = { exists: false, bound: false };
    try {
      const { body } = await coreApi.readNamespacedPersistentVolumeClaim(`${clusterName}-1`, namespace);
      pvc = { exists: true, bound: body.status?.phase === 'Bound', phase: body.status?.phase };
    } catch (e: any) {
      if (e.response?.statusCode !== 404) {
        // Surface non-404 errors as "exists unknown" rather than crashing
      }
    }

    const containerStatuses = (instancePod?.status?.containerStatuses || []) as any[];
    const waiting = containerStatuses
      .map((c) => c.state?.waiting)
      .find((w) => w?.reason);
    const podScheduled = !!instancePod?.spec?.nodeName;
    const podRunning = instancePod?.status?.phase === 'Running';
    const podReady = containerStatuses.length > 0 && containerStatuses.every((c) => c.ready);

    // Events scoped to this cluster's objects. Warnings surface things like
    // FailedScheduling, FailedAttachVolume, BackOff, FailedSync, etc.
    let events: any[] = [];
    try {
      const { body: ev } = await coreApi.listNamespacedEvent(namespace);
      events = (ev.items || [])
        .filter((e: any) => {
          const inv = e.involvedObject || {};
          const name = inv.name || '';
          if (inv.kind === 'Cluster' && name === clusterName) return true;
          if (name === clusterName || name.startsWith(`${clusterName}-`)) return true;
          return false;
        })
        .map((e: any) => ({
          type: e.type,
          reason: e.reason,
          message: e.message,
          kind: e.involvedObject?.kind,
          name: e.involvedObject?.name,
          count: e.count || 1,
          firstTimestamp: e.firstTimestamp,
          lastTimestamp: e.lastTimestamp || e.eventTime || e.firstTimestamp,
        }))
        .sort((a: any, b: any) => {
          const tA = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
          const tB = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
          return tA - tB;
        });
    } catch { /* ignore */ }

    // Import progress
    let importStatus: 'pending' | 'running' | 'completed' | 'failed' | undefined;
    let importLogs: string | undefined;
    let importError: string | undefined;
    if (hasImport) {
      if (importPod) {
        const ipPhase = importPod.status?.phase;
        if (ipPhase === 'Succeeded') importStatus = 'completed';
        else if (ipPhase === 'Failed') importStatus = 'failed';
        else if (ipPhase === 'Running') importStatus = 'running';
        else importStatus = 'pending';

        // Mark failed if any container is in a CrashLoopBackOff / Error state
        const ipContainers = (importPod.status?.containerStatuses || []) as any[];
        const crashy = ipContainers.find((c) =>
          c.state?.waiting?.reason && /Err|BackOff|Failed/.test(c.state.waiting.reason),
        );
        if (crashy) importStatus = 'failed';

        const oomKilled = ipContainers.find((c) => {
          const reason = c.state?.terminated?.reason ?? c.lastState?.terminated?.reason;
          return reason === 'OOMKilled';
        });
        if (oomKilled) {
          importStatus = 'failed';
          importError =
            'The import ran out of memory while restoring data (OOMKilled). Recreate the database with more memory, or contact an admin if this keeps happening.';
        } else if (importStatus === 'failed') {
          const reason = crashy?.state?.waiting?.reason
            ?? ipContainers.find((c) => c.state?.terminated || c.lastState?.terminated)?.state?.terminated?.reason;
          if (reason) importError = `The import pod failed (${reason}). Check the migration logs below.`;
        }

        if (opts?.fetchImportLogs && importPod.metadata?.name) {
          try {
            const { body } = await coreApi.readNamespacedPodLog(
              importPod.metadata.name,
              namespace,
              undefined,
              false,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              500,
            );
            importLogs = typeof body === 'string' ? body : String(body ?? '');
          } catch { /* ignore */ }
        }
      } else if (ready) {
        importStatus = 'completed';
      } else {
        importStatus = 'pending';
      }
    }

    return {
      exists: !!cluster,
      phase,
      ready,
      readyInstances,
      instances,
      hasImport,
      importError,
      pvc,
      instancePod: instancePod
        ? {
            name: instancePod.metadata?.name,
            phase: instancePod.status?.phase,
            scheduled: podScheduled,
            running: podRunning,
            ready: podReady,
            waiting: waiting
              ? { reason: waiting.reason, message: waiting.message }
              : null,
            nodeName: instancePod.spec?.nodeName || null,
          }
        : null,
      importPod: importPod
        ? {
            name: importPod.metadata?.name,
            phase: importPod.status?.phase,
            status: importStatus,
          }
        : null,
      importStatus,
      importLogs,
      conditions: cluster?.status?.conditions || [],
      events,
    };
  }

  async findCnpgPrimaryPod(namespace: string, clusterName: string): Promise<string> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listNamespacedPod(
      namespace, undefined, undefined, undefined, undefined,
      `cnpg.io/cluster=${clusterName},cnpg.io/instanceRole=primary`,
    );
    const pod = body.items[0];
    if (!pod?.metadata?.name) {
      // Fallback: any pod belonging to the cluster.
      const { body: fb } = await coreApi.listNamespacedPod(
        namespace, undefined, undefined, undefined, undefined,
        `cnpg.io/cluster=${clusterName}`,
      );
      if (!fb.items[0]?.metadata?.name) {
        throw new NotFoundException(`No CNPG pod for cluster ${clusterName}`);
      }
      return fb.items[0].metadata.name;
    }
    return pod.metadata.name;
  }

  async createCnpgBackup(namespace: string, clusterName: string, backupName: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const body = {
      apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
      kind: 'Backup',
      metadata: {
        name: backupName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': clusterName,
        },
      },
      spec: { cluster: { name: clusterName } },
    };
    await customApi.createNamespacedCustomObject(
      this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_BACKUP_PLURAL, body,
    );
  }

  async getCnpgBackup(namespace: string, backupName: string): Promise<any> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_BACKUP_PLURAL, backupName,
      );
      return body;
    } catch (e: any) {
      if (e.response?.statusCode === 404) return null;
      throw e;
    }
  }

  async listCnpgBackups(namespace: string, clusterName: string): Promise<any[]> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const { body } = await customApi.listNamespacedCustomObject(
      this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_BACKUP_PLURAL,
    );
    const items: any[] = (body as any).items || [];
    return items.filter((b) => b.spec?.cluster?.name === clusterName);
  }

  async deleteCnpgBackup(namespace: string, backupName: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.deleteNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_BACKUP_PLURAL, backupName,
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  async restoreCnpgCluster(
    namespace: string,
    sourceClusterName: string,
    backupName: string,
    options: {
      dbName: string;
      dbUser: string;
      dbPassword: string;
      storageSize?: string;
      imageName?: string;
      parameters?: Record<string, string>;
      sharedPreloadLibraries?: string[];
      r2?: { endpoint: string; bucket: string; region?: string; accessKey: string; secretKey: string };
      newClusterName?: string;
    },
  ): Promise<{ host: string; port: number; newClusterName: string }> {
    this.ensureKubeConfig();
    await this.ensureCnpgOperatorIngress(
      String(namespace || '').trim(),
    ).catch((e) => {
      this.logger.warn(`allow-cnpg-operator ensure failed: ${e?.message || e}`);
    });
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const suffix = Date.now().toString(36);
    const newName = options.newClusterName || `${sourceClusterName}-r${suffix}`.substring(0, 53);

    const appSecret = this.buildAppSecretName(newName);
    await this.upsertSecret(coreApi, namespace, appSecret, 'kubernetes.io/basic-auth', {
      username: Buffer.from(options.dbUser).toString('base64'),
      password: Buffer.from(options.dbPassword).toString('base64'),
    }, { 'app.kubernetes.io/managed-by': 'orchard' });

    let r2SecretName: string | undefined;
    if (options.r2) {
      r2SecretName = `${newName}-r2`;
      await this.upsertSecret(coreApi, namespace, r2SecretName, 'Opaque', {
        ACCESS_KEY_ID: Buffer.from(options.r2.accessKey).toString('base64'),
        ACCESS_SECRET_KEY: Buffer.from(options.r2.secretKey).toString('base64'),
      }, { 'app.kubernetes.io/managed-by': 'orchard' });
    }

    const spec: any = {
      instances: 1,
      imageName: options.imageName || 'ghcr.io/cloudnative-pg/postgresql:17',
      storage: { size: options.storageSize || '1Gi', storageClass: process.env.K8S_STORAGE_CLASS || 'longhorn' },
      bootstrap: {
        recovery: {
          backup: { name: backupName },
        },
      },
      postgresql: {
        parameters: {
          max_connections: '100',
          shared_buffers: '128MB',
          ...options.parameters,
        },
        ...(options.sharedPreloadLibraries && options.sharedPreloadLibraries.length > 0
          ? { shared_preload_libraries: options.sharedPreloadLibraries }
          : {}),
      },
      enableSuperuserAccess: true,
    };

    if (options.r2 && r2SecretName) {
      // Preserve scheme (http for in-cluster r2-proxy, https for direct R2).
      const endpointRaw = options.r2.endpoint.replace(/\/$/, '');
      const endpointURL = /^https?:\/\//.test(endpointRaw) ? endpointRaw : `https://${endpointRaw}`;
      spec.backup = {
        barmanObjectStore: {
          destinationPath: `s3://${options.r2.bucket}/${namespace}/${newName}`,
          endpointURL,
          s3Credentials: {
            accessKeyId: { name: r2SecretName, key: 'ACCESS_KEY_ID' },
            secretAccessKey: { name: r2SecretName, key: 'ACCESS_SECRET_KEY' },
          },
          wal: { compression: 'gzip' },
          data: { compression: 'gzip' },
        },
        retentionPolicy: '30d',
      };
    }

    const body = {
      apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
      kind: 'Cluster',
      metadata: {
        name: newName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'orchard/restore-source': sourceClusterName,
        },
      },
      spec,
    };

    await customApi.createNamespacedCustomObject(
      this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_PLURAL, body,
    );

    return { host: `${newName}-rw.${namespace}.svc.cluster.local`, port: 5432, newClusterName: newName };
  }

  async updateCnpgParameters(
    namespace: string,
    clusterName: string,
    parameters: Record<string, string>,
    sharedPreloadLibraries?: string[],
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const patch: any = {
      spec: {
        postgresql: {
          parameters,
          ...(sharedPreloadLibraries !== undefined
            ? { shared_preload_libraries: sharedPreloadLibraries }
            : {}),
        },
      },
    };
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_PLURAL, clusterName, patch,
      undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
  }

  async runPsqlInCnpg(
    namespace: string,
    clusterName: string,
    dbName: string,
    sql: string,
    options: { asSuperuser?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; success: boolean }> {
    const pod = await this.findCnpgPrimaryPod(namespace, clusterName);
    const user = options.asSuperuser ? 'postgres' : 'postgres';
    return this.execInPod(namespace, pod, 'postgres', [
      'psql', '-U', user, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c', sql,
    ]);
  }

  async listCnpgExtensions(namespace: string, clusterName: string, dbName: string): Promise<{ name: string; installed: boolean; version?: string; defaultVersion?: string; comment?: string }[]> {
    const pod = await this.findCnpgPrimaryPod(namespace, clusterName);
    const r = await this.execInPod(namespace, pod, 'postgres', [
      'psql', '-U', 'postgres', '-d', dbName, '-t', '-A', '-F', '|', '-c',
      `SELECT a.name, COALESCE(i.extversion, '') AS installed_version, a.default_version, COALESCE(a.comment, '') FROM pg_available_extensions a LEFT JOIN pg_extension i ON a.name = i.extname ORDER BY a.name;`,
    ]);
    if (!r.success) return [];
    const out: { name: string; installed: boolean; version?: string; defaultVersion?: string; comment?: string }[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, installed, defaultVersion, comment] = line.split('|');
      out.push({
        name,
        installed: Boolean(installed),
        version: installed || undefined,
        defaultVersion,
        comment,
      });
    }
    return out;
  }

  async installCnpgExtension(namespace: string, clusterName: string, dbName: string, extName: string): Promise<{ success: boolean; output: string }> {
    const safe = extName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return { success: false, output: 'Invalid extension name' };
    const r = await this.runPsqlInCnpg(namespace, clusterName, dbName, `CREATE EXTENSION IF NOT EXISTS "${safe}" CASCADE;`);
    return { success: r.success, output: r.stdout + r.stderr };
  }

  private scheduledBackupName(clusterName: string): string {
    return `${clusterName}-schedule`.substring(0, 63);
  }

  async upsertScheduledBackup(
    namespace: string,
    clusterName: string,
    cronSchedule: string,
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const name = this.scheduledBackupName(clusterName);
    const body = {
      apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
      kind: 'ScheduledBackup',
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': clusterName,
        },
      },
      spec: {
        schedule: cronSchedule,
        backupOwnerReference: 'self',
        cluster: { name: clusterName },
      },
    };

    try {
      await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_SCHEDULED_BACKUP_PLURAL, name,
      );
      await customApi.replaceNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_SCHEDULED_BACKUP_PLURAL, name, body,
      );
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await customApi.createNamespacedCustomObject(
          this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_SCHEDULED_BACKUP_PLURAL, body,
        );
      } else {
        throw e;
      }
    }
  }

  async deleteScheduledBackup(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const name = this.scheduledBackupName(clusterName);
    try {
      await customApi.deleteNamespacedCustomObject(
        this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_SCHEDULED_BACKUP_PLURAL, name,
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }


  // ── Public TLS (cert-manager wildcard reflection) ──

  private readonly PUBLIC_TLS_SOURCE_NAMESPACE = process.env.PUBLIC_DB_TLS_SOURCE_NAMESPACE || 'network';

  private readonly PUBLIC_TLS_SOURCE_SECRET = process.env.PUBLIC_DB_TLS_SOURCE_SECRET || 'wildcard-db-orchard-my-tls';

  private readonly PUBLIC_TLS_BASE_DOMAIN = process.env.PUBLIC_DB_DOMAIN || 'db.orchard.my';

  private readonly PUBLIC_TLS_LOCAL_SECRET = process.env.PUBLIC_DB_TLS_LOCAL_SECRET || 'wildcard-db-tls';

  publicTlsBaseDomain(): string {
    return this.PUBLIC_TLS_BASE_DOMAIN;
  }

  publicTlsHostname(clusterName: string): string {
    return `${clusterName}.${this.PUBLIC_TLS_BASE_DOMAIN}`;
  }

  /**
   * Copy the wildcard Let's Encrypt Secret from the cert-manager namespace into
   * the project namespace so the CNPG cluster can mount it. Returns true if the
   * secret was updated (or created).
   */
  async syncPublicTlsSecret(targetNamespace: string): Promise<boolean> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const { body: src } = await coreApi.readNamespacedSecret(
      this.PUBLIC_TLS_SOURCE_SECRET, this.PUBLIC_TLS_SOURCE_NAMESPACE,
    );
    if (!src.data?.['tls.crt'] || !src.data?.['tls.key']) {
      throw new Error('Source wildcard secret is missing tls.crt / tls.key');
    }

    // cert-manager stores the leaf + issuing intermediate(s) concatenated in tls.crt and
    // usually does NOT populate ca.crt for public ACME issuers. CNPG requires a ca.crt
    // whose chain verifies tls.crt, so we split tls.crt and use the intermediate(s) as ca.crt.
    let caCrtB64 = src.data['ca.crt'];
    if (!caCrtB64) {
      const fullChainPem = Buffer.from(src.data['tls.crt'], 'base64').toString('utf-8');
      const certs = fullChainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (certs.length >= 2) {
        const intermediates = `${certs.slice(1).join('\n')  }\n`;
        caCrtB64 = Buffer.from(intermediates, 'utf-8').toString('base64');
      }
    }

    const targetName = this.PUBLIC_TLS_LOCAL_SECRET;
    const srcRv = src.metadata?.resourceVersion || '';
    const body: k8s.V1Secret = {
      metadata: {
        name: targetName,
        namespace: targetNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'orchard.my/tls-source-rv': srcRv,
        },
      },
      type: 'kubernetes.io/tls',
      data: {
        'tls.crt': src.data['tls.crt'],
        'tls.key': src.data['tls.key'],
        ...(caCrtB64 ? { 'ca.crt': caCrtB64 } : {}),
      },
    };

    try {
      const { body: existing } = await coreApi.readNamespacedSecret(targetName, targetNamespace);
      const existingRv = existing.metadata?.labels?.['orchard.my/tls-source-rv']
        ?? existing.metadata?.labels?.['orchard.dev/tls-source-rv'];
      if (existingRv === srcRv) return false;
      await coreApi.replaceNamespacedSecret(targetName, targetNamespace, body);
      return true;
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedSecret(targetNamespace, body);
        return true;
      }
      throw e;
    }
  }

  async patchCnpgClusterTls(namespace: string, clusterName: string, _altDnsNames: string[] = []): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    // serverTLSSecret must be signed by serverCASecret. Our sync populates ca.crt with the
    // issuing intermediate (extracted from tls.crt), which satisfies CNPG's verification.
    // Clients still verify using their OS root store since the intermediate chains to ISRG.
    const patch = {
      spec: {
        certificates: {
          serverTLSSecret: this.PUBLIC_TLS_LOCAL_SECRET,
          serverCASecret: this.PUBLIC_TLS_LOCAL_SECRET,
          serverAltDNSNames: null,
        },
      },
    };
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_PLURAL, clusterName, patch,
      undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
  }

  async clearCnpgClusterTls(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    // Merge-patch with null removes the keys, causing CNPG to regenerate its self-signed certs.
    const patch = {
      spec: {
        certificates: {
          serverTLSSecret: null,
          serverCASecret: null,
          serverAltDNSNames: null,
        },
      },
    };
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP, this.CNPG_VERSION, namespace, this.CNPG_PLURAL, clusterName, patch,
      undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
  }


  async uninstallCnpgExtension(namespace: string, clusterName: string, dbName: string, extName: string): Promise<{ success: boolean; output: string }> {
    const safe = extName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return { success: false, output: 'Invalid extension name' };
    const r = await this.runPsqlInCnpg(namespace, clusterName, dbName, `DROP EXTENSION IF EXISTS "${safe}" CASCADE;`);
    return { success: r.success, output: r.stdout + r.stderr };
  }
}
