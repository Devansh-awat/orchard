import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import * as net from 'net';
import { randomUUID } from 'crypto';
import { Duplex, PassThrough } from 'stream';
import { finished } from 'stream/promises';
import type WebSocket from 'ws';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InstanceSettingsService } from '../../instance-settings/instance-settings.service';
import { ApplyQueueService } from '../../apply/apply-queue.service';
import { ApplyExecutorService, ApplyItemInput } from '../../apply/apply-executor.service';
import { ResizableOutput } from '../../kubernetes/exec-sessions';
import { SANDBOX_BOOTSTRAP_SCRIPT } from '../sandbox-bootstrap';
import { PREVIEW_PORTS } from '../preview/preview-auth';
import {
  CRD_API_VERSION,
  CRD_GROUP,
  CRD_KIND,
  CRD_PLURAL,
  CRD_VERSION,
  INSTANCE_LABEL,
  INSTANCE_SETTING_KEY,
  MANAGED_BY,
  SANDBOX_CR_ABSENT,
  SANDBOX_ID_LABEL,
  SANDBOX_SHARD,
  SPEC_HASH_ANNOTATION,
  SandboxCrStatus,
  readSandboxCr,
  sandboxStatusFromCr
} from '../sandbox-cr';
import {
  ExecOptions,
  ExecResult,
  ExecStream,
  HttpTarget,
  PtyHandle,
  PtyOptions,
  ReadFileOptions,
  ReadFileResult,
  RunnerObservation,
  SANDBOX_REF_SELECT,
  SandboxFileWrite,
  SandboxNotRunningError,
  SandboxRef,
  SandboxRunner,
  SandboxRunnerCapabilities,
  SandboxSecrets,
  SandboxSpec,
  WriteFilesOptions,
  specOf
} from './sandbox-runner';
import { SandboxSecretsService, sandboxSpecHash } from './sandbox-secrets';
import { authorizedKeysFile, opencodeAuthJson, opencodeConfigJson } from './sandbox-init-files';
import { applyObservation } from './sandbox-status';

const MIRROR_FRESH_MS = 60_000;
const CONTAINER = 'sandbox';
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;
const STDIN_CHUNK = 32 * 1024;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
const MISSING_FILE_EXIT = 44;

export const SANDBOX_OP_CR = 'sandbox.cr.apply';
export const SANDBOX_OP_SECRET = 'sandbox.secret.sync';
export const SANDBOX_OP_DESTROY = 'sandbox.destroy';

export const sandboxCrKey = (id: string) => `sandbox:${id}:cr`;
export const sandboxSecretKey = (id: string) => `sandbox:${id}:secret`;
export const sandboxDestroyKey = (id: string) => `sandbox:${id}:destroy`;
export const SANDBOX_NS_KEY = 'sandboxes:ns';
export const SANDBOX_NETPOL_KEY = 'sandboxes:netpol';

export function sandboxHomeMode(): 'block' | 'filesystem' {
  const mode = process.env.SANDBOX_HOME_MODE || 'auto';
  if (mode === 'block' || mode === 'filesystem') return mode;
  return process.env.SANDBOX_RUNTIME_CLASS ? 'block' : 'filesystem';
}

function isPodLive(pod: any): boolean {
  return pod?.status?.phase === 'Running' && !pod?.metadata?.deletionTimestamp;
}

function statusCode(e: any): number | undefined {
  return e?.response?.statusCode ?? e?.statusCode;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function exitCodeOf(status: k8s.V1Status | undefined): number | null {
  if (!status) return null;
  if (status.status === 'Success') return 0;
  const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
  const code = Number(cause?.message);
  return Number.isFinite(code) ? code : null;
}

function asUser(user: string | undefined, script: string): string[] {
  if (!user) return ['/bin/sh', '-c', script];
  if (!USER_RE.test(user)) throw new Error(`invalid sandbox user ${user}`);
  return ['su', user, '-s', '/bin/sh', '-c', script];
}

class PortForwardSocket extends Duplex {
  private ws: WebSocket | null = null;

  constructor(
    private readonly input: PassThrough,
    private readonly output: PassThrough
  ) {
    super();
    this.output.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) this.output.pause();
    });
  }

  attach(ws: WebSocket): void {
    this.ws = ws;
    ws.on('close', () => {
      this.push(null);
      this.destroy();
    });
  }

  _read(): void {
    this.output.resume();
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.input.write(chunk)) callback();
    else this.input.once('drain', () => callback());
  }

  _final(callback: (error?: Error | null) => void): void {
    this.input.end();
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.input.end();
    try {
      this.ws?.close();
    } catch {}
    callback(error);
  }
}

interface RawExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  ok: boolean;
}

@Injectable()
export class KubernetesSandboxRunner implements SandboxRunner {
  readonly id = 'kubernetes' as const;

  readonly label = 'Kubernetes';

  private readonly logger = new Logger(KubernetesSandboxRunner.name);

  private instanceIdCache: string | null = null;

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
    private readonly queue: ApplyQueueService,
    private readonly executor: ApplyExecutorService,
    private readonly secrets: SandboxSecretsService
  ) {
    this.executor.registerHandler(SANDBOX_OP_CR, (item) => this.applyCr(item));
    this.executor.registerHandler(SANDBOX_OP_SECRET, (item) => this.applySecret(item));
    this.executor.registerHandler(SANDBOX_OP_DESTROY, (item) => this.applyDestroy(item));
  }

  get capabilities(): SandboxRunnerCapabilities {
    return {
      statusSource: 'watch',
      persistence: 'volume',
      homeMode: sandboxHomeMode(),
      tcpTunnel: 'native',
      pty: 'native',
      execStdin: true,
      maxRunMs: null,
      diskSizeConfigurable: true,
      fork: false,
      previews: 'none'
    };
  }

  configError(): string | null {
    return this.kubernetes.kc ? null : 'Kubernetes is not configured on this server';
  }

  get namespace(): string {
    return process.env.SANDBOX_NAMESPACE || 'orchard-sandboxes';
  }

  async instanceId(): Promise<string> {
    if (this.instanceIdCache) return this.instanceIdCache;
    const existing = await this.settings.get(INSTANCE_SETTING_KEY);
    if (existing) {
      this.instanceIdCache = existing;
      return existing;
    }
    await this.settings.createIfAbsent(INSTANCE_SETTING_KEY, randomUUID());
    const value = await this.settings.get(INSTANCE_SETTING_KEY);
    if (!value) throw new Error('could not resolve the sandbox instance id');
    this.instanceIdCache = value;
    return value;
  }

  private get kc(): k8s.KubeConfig {
    if (!this.kubernetes.kc) throw new Error('Kubernetes is not configured');
    return this.kubernetes.kc;
  }

  private custom(): k8s.CustomObjectsApi {
    return this.kc.makeApiClient(k8s.CustomObjectsApi);
  }

  private core(): k8s.CoreV1Api {
    return this.kc.makeApiClient(k8s.CoreV1Api);
  }

  private get mirrorDisabled(): boolean {
    return process.env.MIRROR_DISABLED === 'true';
  }

  secretName(podName: string): string {
    return `${podName}-auth`;
  }

  private labels(spec: { id: string; userId: string }, instanceId: string): Record<string, string> {
    return {
      'app.kubernetes.io/name': 'sandbox',
      'app.kubernetes.io/managed-by': MANAGED_BY,
      [SANDBOX_ID_LABEL]: spec.id,
      'orchard.my/user-id': spec.userId,
      [INSTANCE_LABEL]: instanceId
    };
  }

  namespaceManifest(): k8s.KubernetesObject {
    return {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'Helm',
          'pod-security.kubernetes.io/enforce': 'privileged',
          'pod-security.kubernetes.io/audit': 'privileged',
          'pod-security.kubernetes.io/warn': 'privileged'
        },
        annotations: {
          'meta.helm.sh/release-name': 'orchard',
          'meta.helm.sh/release-namespace': process.env.ORCHARD_SERVER_NAMESPACE || 'orchard'
        }
      }
    };
  }

  networkPolicyManifest(): k8s.KubernetesObject {
    const serverNamespace = process.env.ORCHARD_SERVER_NAMESPACE || 'orchard';
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'sandbox-isolation',
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'Helm' },
        annotations: {
          'meta.helm.sh/release-name': 'orchard',
          'meta.helm.sh/release-namespace': serverNamespace
        }
      },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': serverNamespace }
                },
                podSelector: { matchLabels: { 'app.kubernetes.io/name': 'server' } }
              }
            ],
            ports: [
              { protocol: 'TCP', port: 22 as any },
              { protocol: 'TCP', port: 4096 as any },
              ...PREVIEW_PORTS.map((port) => ({ protocol: 'TCP', port: port as any }))
            ]
          }
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' }
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } }
              }
            ],
            ports: [
              { protocol: 'UDP', port: 53 as any },
              { protocol: 'TCP', port: 53 as any }
            ]
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: '0.0.0.0/0',
                  except: [
                    '10.0.0.0/8',
                    '172.16.0.0/12',
                    '192.168.0.0/16',
                    '169.254.0.0/16',
                    '100.64.0.0/10'
                  ]
                }
              }
            ]
          }
        ]
      }
    };
    return policy as k8s.KubernetesObject;
  }

  async enqueueInfrastructure(): Promise<void> {
    await this.queue.enqueue({
      dedupeKey: SANDBOX_NS_KEY,
      opType: 'ssa',
      manifest: this.namespaceManifest()
    });
    await this.queue.enqueue({
      dedupeKey: SANDBOX_NETPOL_KEY,
      opType: 'ssa',
      manifest: this.networkPolicyManifest()
    });
  }

  async requestProvision(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.enqueueInfrastructure();
    await this.requestSecretSync(ref, requestedById);
    await this.enqueueCr(ref.id, requestedById);
  }

  async requestStart(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.requestSecretSync(ref, requestedById);
    await this.enqueueCr(ref.id, requestedById);
  }

  async requestStop(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.enqueueCr(ref.id, requestedById);
  }

  async requestDestroy(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.queue.enqueue({
      dedupeKey: sandboxDestroyKey(ref.id),
      opType: SANDBOX_OP_DESTROY,
      manifest: { sandboxId: ref.id, podName: ref.podName },
      sandboxId: ref.id,
      requestedById: requestedById ?? undefined
    });
  }

  async requestSecretSync(ref: SandboxRef, requestedById?: string | null): Promise<void> {
    await this.queue.enqueue({
      dedupeKey: sandboxSecretKey(ref.id),
      opType: SANDBOX_OP_SECRET,
      manifest: { sandboxId: ref.id },
      sandboxId: ref.id,
      requestedById: requestedById ?? undefined
    });
  }

  async enqueueCr(sandboxId: string, requestedById?: string | null): Promise<void> {
    await this.queue.enqueue({
      dedupeKey: sandboxCrKey(sandboxId),
      opType: SANDBOX_OP_CR,
      manifest: { sandboxId },
      sandboxId,
      requestedById: requestedById ?? undefined
    });
  }

  async requestOrphanDestroy(podName: string): Promise<void> {
    const id = podName.match(/^sbx-(.+)$/)?.[1] ?? podName;
    await this.queue.enqueue({
      dedupeKey: sandboxDestroyKey(id),
      opType: SANDBOX_OP_DESTROY,
      manifest: { sandboxId: null, podName }
    });
  }

  private manifestOf(item: ApplyItemInput): { sandboxId: string | null; podName: string | null } {
    const manifest = (item.manifest ?? {}) as { sandboxId?: unknown; podName?: unknown };
    return {
      sandboxId: typeof manifest.sandboxId === 'string' ? manifest.sandboxId : null,
      podName: typeof manifest.podName === 'string' ? manifest.podName : null
    };
  }

  private async applyCr(item: ApplyItemInput): Promise<void> {
    const { sandboxId } = this.manifestOf(item);
    if (!sandboxId) return;
    const row = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: {
        ...SANDBOX_REF_SELECT,
        status: true,
        desiredState: true,
        repoUrl: true,
        image: true,
        cpuLimit: true,
        memoryLimit: true,
        diskSize: true,
        setupScript: true
      }
    });
    if (!row || row.runner !== 'kubernetes' || row.desiredState === 'deleted') return;
    const guard = { id: row.id, status: row.status, desiredState: row.desiredState };

    if (row.desiredState === 'stopped') {
      const patched = await this.patchOperatingMode(row.podName, 'Suspended');
      if (!patched) {
        await this.prisma.sandbox.updateMany({
          where: { ...guard, status: 'stopping' },
          data: { status: 'stopped' }
        });
        return;
      }
      await applyObservation(this.prisma, guard, this.observationOf(readSandboxCr(patched)));
      return;
    }

    const instanceId = await this.instanceId();
    const existing = await this.existingCr(row.podName);
    const applied = await this.executor.ssaApply(
      this.buildCr(specOf(row), instanceId, existing) as k8s.KubernetesObject
    );
    await applyObservation(this.prisma, guard, this.observationOf(readSandboxCr(applied)));
  }

  private async applySecret(item: ApplyItemInput): Promise<void> {
    const { sandboxId } = this.manifestOf(item);
    if (!sandboxId) return;
    const row = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: {
        ...SANDBOX_REF_SELECT,
        desiredState: true,
        sshIdentityId: true,
        setupScript: true
      }
    });
    if (!row || row.runner !== 'kubernetes' || row.desiredState === 'deleted') return;
    const data = this.secretData(await this.secrets.forSandbox(row));
    const hash = sandboxSpecHash(row.id, data);
    const name = this.secretName(row.podName);
    const body: k8s.V1Secret = {
      metadata: {
        name,
        namespace: this.namespace,
        labels: this.labels(row, await this.instanceId()),
        annotations: { [SPEC_HASH_ANNOTATION]: hash }
      },
      type: 'Opaque',
      stringData: data
    };
    const core = this.core();
    try {
      await core.readNamespacedSecret(name, this.namespace);
      await core.replaceNamespacedSecret(name, this.namespace, body);
    } catch (e: any) {
      if (statusCode(e) !== 404) throw e;
      await core.createNamespacedSecret(this.namespace, body);
    }
    const state =
      row.runnerState && typeof row.runnerState === 'object'
        ? (row.runnerState as Record<string, unknown>)
        : {};
    await this.prisma.sandbox.updateMany({
      where: { id: row.id },
      data: { runnerState: { ...state, secretHash: hash } }
    });
  }

  private async applyDestroy(item: ApplyItemInput): Promise<void> {
    const manifest = this.manifestOf(item);
    const row = manifest.sandboxId
      ? await this.prisma.sandbox.findUnique({
          where: { id: manifest.sandboxId },
          select: { id: true, podName: true, desiredState: true, runner: true }
        })
      : null;
    if (row && (row.desiredState !== 'deleted' || row.runner !== 'kubernetes')) {
      this.logger.warn(`refusing to destroy sandbox ${row.id}: it is not marked for deletion`);
      return;
    }
    const podName = row?.podName ?? manifest.podName;
    if (!podName) return;
    const claimant = await this.prisma.sandbox.findUnique({
      where: { podName },
      select: { id: true, desiredState: true }
    });
    if (claimant && claimant.desiredState !== 'deleted') {
      this.logger.warn(`refusing to destroy ${podName}: sandbox ${claimant.id} still claims it`);
      return;
    }
    const id = row?.id ?? manifest.sandboxId ?? podName.match(/^sbx-(.+)$/)?.[1] ?? podName;
    await this.deleteResources(id, podName);
    if (row) {
      await this.prisma.sandbox.deleteMany({ where: { id: row.id, desiredState: 'deleted' } });
    }
  }

  secretData(input: SandboxSecrets): Record<string, string> {
    const data: Record<string, string> = {
      authorized_keys: authorizedKeysFile(input.authorizedKeys),
      'bootstrap.sh': SANDBOX_BOOTSTRAP_SCRIPT
    };
    if (input.githubToken) data['github-token'] = input.githubToken;
    if (input.claudeToken) data['claude-token'] = input.claudeToken;
    if (input.openaiToken) data['openai-token'] = input.openaiToken;
    data['setup.sh'] = input.setupScript || '';
    data['opencode-auth.json'] = opencodeAuthJson(input.claudeToken);
    data['opencode-config.json'] = opencodeConfigJson(input.mcpToken);
    return data;
  }

  private async existingCr(podName: string): Promise<any | null> {
    if (!this.mirrorDisabled) {
      const row = await this.prisma.k8sObject.findUnique({
        where: {
          kind_namespace_name_apiVersion: {
            kind: CRD_KIND,
            namespace: this.namespace,
            name: podName,
            apiVersion: CRD_API_VERSION
          }
        },
        select: { manifest: true }
      });
      if (row) return row.manifest;
    }
    try {
      const res: any = await this.custom().getNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        this.namespace,
        CRD_PLURAL,
        podName
      );
      return res.body;
    } catch (e: any) {
      if (statusCode(e) === 404) return null;
      throw e;
    }
  }

  buildCr(spec: SandboxSpec, instanceId: string, existing: any | null = null): Record<string, any> {
    const existingClaims = existing?.spec?.volumeClaimTemplates;
    const claims = Array.isArray(existingClaims) && existingClaims.length ? existingClaims : null;
    const homeClaim = claims?.find((c: any) => c?.metadata?.name === 'home') ?? claims?.[0];
    const homeMode = homeClaim
      ? homeClaim.spec?.volumeMode === 'Block'
        ? 'block'
        : 'filesystem'
      : sandboxHomeMode();
    const runtimeClass = process.env.SANDBOX_RUNTIME_CLASS || '';
    const secretName = this.secretName(spec.podName);
    const secretEnv = (name: string, key: string) => ({
      name,
      valueFrom: { secretKeyRef: { name: secretName, key, optional: true } }
    });
    const container: Record<string, any> = {
      name: CONTAINER,
      image: spec.image,
      command: ['/bin/bash', '/orchard-init/bootstrap.sh'],
      ports: [{ containerPort: 22, name: 'ssh' }],
      env: [
        { name: 'SANDBOX_REPO_URL', value: spec.repoUrl || '' },
        { name: 'SANDBOX_HOME_MODE', value: homeMode },
        secretEnv('GIT_TOKEN', 'github-token'),
        secretEnv('CLAUDE_CODE_OAUTH_TOKEN', 'claude-token'),
        secretEnv('OPENAI_API_KEY', 'openai-token')
      ],
      resources: {
        requests: { cpu: '250m', memory: '512Mi' },
        limits: { cpu: spec.cpuLimit, memory: spec.memoryLimit }
      },
      volumeMounts: [
        { name: 'authkeys', mountPath: '/etc/ssh/authorized_keys.d', readOnly: true },
        { name: 'init', mountPath: '/orchard-init', readOnly: true }
      ]
    };
    if (homeMode === 'block') {
      container.volumeDevices = [{ name: 'home', devicePath: '/dev/sandboxhome' }];
      container.securityContext = { privileged: true };
    } else {
      container.volumeMounts.push({ name: 'home', mountPath: '/persist' });
    }
    const labels = this.labels(spec, instanceId);
    return {
      apiVersion: CRD_API_VERSION,
      kind: CRD_KIND,
      metadata: { name: spec.podName, namespace: this.namespace, labels },
      spec: {
        operatingMode: 'Running',
        service: true,
        podTemplate: {
          metadata: { labels },
          spec: {
            ...(runtimeClass ? { runtimeClassName: runtimeClass } : {}),
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            containers: [container],
            volumes: [
              {
                name: 'authkeys',
                secret: {
                  secretName,
                  items: [{ key: 'authorized_keys', path: 'authorized_keys' }],
                  defaultMode: 0o644,
                  optional: false
                }
              },
              {
                name: 'init',
                secret: {
                  secretName,
                  items: [
                    { key: 'bootstrap.sh', path: 'bootstrap.sh' },
                    { key: 'setup.sh', path: 'setup.sh' },
                    { key: 'opencode-auth.json', path: 'opencode-auth.json' },
                    { key: 'opencode-config.json', path: 'opencode-config.json' }
                  ],
                  defaultMode: 0o644,
                  optional: false
                }
              }
            ]
          }
        },
        volumeClaimTemplates: claims ?? [
          {
            metadata: { name: 'home', labels },
            spec: {
              accessModes: ['ReadWriteOnce'],
              volumeMode: homeMode === 'block' ? 'Block' : 'Filesystem',
              ...(process.env.SANDBOX_STORAGE_CLASS
                ? { storageClassName: process.env.SANDBOX_STORAGE_CLASS }
                : {}),
              resources: { requests: { storage: spec.diskSize } }
            }
          }
        ]
      }
    };
  }

  private async patchOperatingMode(
    podName: string,
    mode: 'Running' | 'Suspended'
  ): Promise<any | null> {
    try {
      const res: any = await this.custom().patchNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        this.namespace,
        CRD_PLURAL,
        podName,
        { spec: { operatingMode: mode } },
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
      return res.body ?? {};
    } catch (e: any) {
      if (statusCode(e) !== 404) throw e;
      return null;
    }
  }

  private async deleteResources(sandboxId: string, podName: string): Promise<void> {
    const custom = this.custom();
    const core = this.core();
    try {
      await custom.deleteNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        this.namespace,
        CRD_PLURAL,
        podName
      );
    } catch (e: any) {
      if (statusCode(e) !== 404) throw e;
    }
    try {
      await core.deleteNamespacedSecret(this.secretName(podName), this.namespace);
    } catch (e: any) {
      if (statusCode(e) !== 404) throw e;
    }
    const pvcs = await core.listNamespacedPersistentVolumeClaim(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `${SANDBOX_ID_LABEL}=${sandboxId}`
    );
    const claims = pvcs.body.items.length
      ? pvcs.body.items
      : (await core.listNamespacedPersistentVolumeClaim(this.namespace)).body.items.filter((p) =>
          p.metadata?.name?.includes(podName)
        );
    for (const pvc of claims) {
      if (!pvc.metadata?.name) continue;
      try {
        await core.deleteNamespacedPersistentVolumeClaim(pvc.metadata.name, this.namespace);
      } catch (e: any) {
        if (statusCode(e) !== 404) throw e;
      }
    }
  }

  private observationOf(cr: SandboxCrStatus): RunnerObservation {
    return { exists: cr.exists, status: sandboxStatusFromCr(cr), message: cr.message };
  }

  async observe(ref: SandboxRef): Promise<RunnerObservation> {
    return this.observationOf(await this.getCrStatus(ref.podName));
  }

  async observeDisks(refs: SandboxRef[]): Promise<Map<string, string>> {
    const ids = refs.map((ref) => ref.id);
    const disks = new Map<string, string>();
    if (ids.length === 0 || this.mirrorDisabled) return disks;
    const rows = await this.prisma.$queryRaw<{ id: string | null; capacity: string | null }[]>`
      SELECT "manifest"->'metadata'->'labels'->>${SANDBOX_ID_LABEL} AS "id",
             "manifest"->'status'->'capacity'->>'storage' AS "capacity"
      FROM "k8s_objects"
      WHERE "shard" = ${SANDBOX_SHARD}
        AND "kind" = 'PersistentVolumeClaim'
        AND "namespace" = ${this.namespace}
        AND "manifest"->'metadata'->'labels'->>${SANDBOX_ID_LABEL} = ANY(${ids}::text[])
    `;
    for (const row of rows) {
      if (row.id && row.capacity && !disks.has(row.id)) disks.set(row.id, row.capacity);
    }
    return disks;
  }

  async getCrStatus(podName: string): Promise<SandboxCrStatus> {
    if (this.mirrorDisabled) return this.readCrFromCluster(podName);
    const row = await this.prisma.k8sObject.findUnique({
      where: {
        kind_namespace_name_apiVersion: {
          kind: CRD_KIND,
          namespace: this.namespace,
          name: podName,
          apiVersion: CRD_API_VERSION
        }
      },
      select: { manifest: true }
    });
    return row ? readSandboxCr(row.manifest) : SANDBOX_CR_ABSENT;
  }

  private async readCrFromCluster(podName: string): Promise<SandboxCrStatus> {
    try {
      const res: any = await this.custom().getNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        this.namespace,
        CRD_PLURAL,
        podName
      );
      return readSandboxCr(res.body);
    } catch (e: any) {
      if (statusCode(e) === 404) return SANDBOX_CR_ABSENT;
      throw e;
    }
  }

  async canTrustAbsence(): Promise<boolean> {
    if (this.mirrorDisabled) return true;
    const row = await this.prisma.k8sMirrorHeartbeat.findUnique({
      where: { shard: SANDBOX_SHARD },
      select: { holder: true, healthy: true, lastListAt: true, updatedAt: true }
    });
    if (!row?.holder || !row.healthy || !row.lastListAt) return false;
    return Date.now() - row.updatedAt.getTime() < MIRROR_FRESH_MS;
  }

  private async resolvePodIp(ref: SandboxRef): Promise<string | null> {
    const status = await this.getCrStatus(ref.podName);
    if (status.podIp) return status.podIp;
    const pod = await this.runningPod(ref.id);
    return pod?.ip ?? null;
  }

  private async runningPod(sandboxId: string): Promise<{ name: string; ip: string | null } | null> {
    if (!this.mirrorDisabled) {
      const rows = await this.prisma.k8sObject.findMany({
        where: {
          kind: 'Pod',
          namespace: this.namespace,
          shard: SANDBOX_SHARD,
          manifest: { path: ['metadata', 'labels', SANDBOX_ID_LABEL], equals: sandboxId }
        },
        select: { manifest: true }
      });
      for (const row of rows) {
        const pod = row.manifest as any;
        if (!isPodLive(pod)) continue;
        return { name: String(pod.metadata.name), ip: pod.status.podIP ?? null };
      }
      if (await this.canTrustAbsence()) return null;
    }
    const pods = await this.core().listNamespacedPod(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `${SANDBOX_ID_LABEL}=${sandboxId}`
    );
    const live = pods.body.items.find(isPodLive);
    if (!live?.metadata?.name) return null;
    return { name: live.metadata.name, ip: live.status?.podIP ?? null };
  }

  private async requirePod(ref: SandboxRef): Promise<{ name: string; ip: string | null }> {
    if (!this.kubernetes.kc) throw new SandboxNotRunningError('Kubernetes is not configured');
    const pod = await this.runningPod(ref.id);
    if (!pod) throw new SandboxNotRunningError('Sandbox pod is not running');
    return pod;
  }

  private wrapCommand(command: string[], opts: ExecOptions): string[] {
    let cmd = command;
    const env = Object.entries(opts.env ?? {});
    if (env.length) {
      for (const [key] of env) {
        if (!ENV_NAME_RE.test(key)) throw new Error(`invalid environment variable name ${key}`);
      }
      cmd = ['env', ...env.map(([k, v]) => `${k}=${v}`), ...cmd];
    }
    if (opts.stdin) {
      cmd = ['/bin/sh', '-c', `head -c ${opts.stdin.length} | "$@"`, 'sh', ...cmd];
    }
    return cmd;
  }

  private feed(stdin: PassThrough, payload: Buffer): void {
    for (let i = 0; i < payload.length; i += STDIN_CHUNK) {
      stdin.write(payload.subarray(i, i + STDIN_CHUNK));
    }
  }

  private async run(
    ref: SandboxRef,
    command: string[],
    opts: ExecOptions = {}
  ): Promise<RawExecResult> {
    const pod = await this.requirePod(ref);
    const cmd = this.wrapCommand(command, opts);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => out.push(chunk));
    stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const stdin = opts.stdin ? new PassThrough() : null;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    return new Promise<RawExecResult>((resolve, reject) => {
      let ws: WebSocket | null = null;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      timer = setTimeout(() => {
        settle(() => {
          try {
            ws?.close();
          } catch {}
          reject(new Error('sandbox command timed out'));
        });
      }, timeoutMs);
      new k8s.Exec(this.kc)
        .exec(this.namespace, pod.name, CONTAINER, cmd, stdout, stderr, stdin, false, (status) => {
          void Promise.all([
            finished(stdout).catch(() => {}),
            finished(stderr).catch(() => {})
          ]).then(() =>
            settle(() =>
              resolve({
                stdout: Buffer.concat(out),
                stderr: Buffer.concat(err),
                exitCode: exitCodeOf(status),
                ok: status?.status === 'Success'
              })
            )
          );
        })
        .then((socket) => {
          ws = socket as unknown as WebSocket;
          if (settled) {
            ws.close();
            return;
          }
          ws.on('close', () => {
            setTimeout(() => {
              settle(() => reject(new Error('sandbox exec connection closed')));
            }, 1000).unref?.();
          });
          if (stdin && opts.stdin) this.feed(stdin, opts.stdin);
        })
        .catch((e) => settle(() => reject(e)));
    });
  }

  async exec(ref: SandboxRef, command: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.run(ref, command, opts);
    return {
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      exitCode: result.exitCode,
      ok: result.ok
    };
  }

  async execStream(
    ref: SandboxRef,
    command: string[],
    opts: ExecOptions = {}
  ): Promise<ExecStream> {
    const pod = await this.requirePod(ref);
    const cmd = this.wrapCommand(command, opts);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = opts.stdin ? new PassThrough() : null;
    let resolveDone!: (value: {
      ok: boolean;
      exitCode: number | null;
      message: string | null;
    }) => void;
    const done = new Promise<{ ok: boolean; exitCode: number | null; message: string | null }>(
      (resolve) => {
        resolveDone = resolve;
      }
    );
    let finishedOnce = false;
    const finish = (value: { ok: boolean; exitCode: number | null; message: string | null }) => {
      if (finishedOnce) return;
      finishedOnce = true;
      if (!stdout.writableEnded) stdout.end();
      if (!stderr.writableEnded) stderr.end();
      resolveDone(value);
    };
    let ws: WebSocket | null = null;
    let killed = false;
    const socket = await new k8s.Exec(this.kc)
      .exec(this.namespace, pod.name, CONTAINER, cmd, stdout, stderr, stdin, false, (status) =>
        finish({
          ok: status?.status === 'Success',
          exitCode: exitCodeOf(status),
          message: status?.message ?? null
        })
      )
      .catch((e: any) => {
        finish({ ok: false, exitCode: null, message: e?.message ?? 'failed to reach the sandbox' });
        return null;
      });
    if (socket) {
      ws = socket as unknown as WebSocket;
      ws.on('close', () => {
        setTimeout(() => {
          finish({
            ok: false,
            exitCode: null,
            message: killed ? 'killed' : 'sandbox exec connection closed'
          });
        }, 1000).unref?.();
      });
      if (killed) ws.close();
      else if (stdin && opts.stdin) this.feed(stdin, opts.stdin);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        try {
          ws?.close();
        } catch {}
        finish({ ok: false, exitCode: null, message: 'sandbox command timed out' });
      }, opts.timeoutMs);
      void done.then(() => clearTimeout(timer));
    }
    return {
      stdout,
      stderr,
      done,
      kill: () => {
        killed = true;
        try {
          ws?.close();
        } catch {}
      }
    };
  }

  async writeFiles(
    ref: SandboxRef,
    files: SandboxFileWrite[],
    opts: WriteFilesOptions = {}
  ): Promise<void> {
    for (const file of files) {
      if (!file.path.startsWith('/') || file.path.includes('\0')) {
        throw new Error('sandbox file paths must be absolute');
      }
      const path = shellQuote(file.path);
      const result = await this.run(
        ref,
        asUser(opts.asUser, `mkdir -p "$(dirname ${path})" && cat > ${path}`),
        { stdin: file.content, timeoutMs: opts.timeoutMs ?? 30_000 }
      );
      if (!result.ok) {
        const detail = result.stderr.toString('utf8').trim().slice(-300);
        throw new Error(`could not write ${file.path}${detail ? `: ${detail}` : ''}`);
      }
    }
  }

  async readFile(
    ref: SandboxRef,
    path: string,
    opts: ReadFileOptions
  ): Promise<ReadFileResult | null> {
    if (!path.startsWith('/') || path.includes('\0')) {
      throw new Error('sandbox file paths must be absolute');
    }
    const max = Math.max(0, Math.floor(opts.maxBytes));
    const quoted = shellQuote(path);
    const read = opts.fromEnd
      ? `tail -c ${max + 1} -- ${quoted}`
      : `head -c ${max + 1} -- ${quoted}`;
    const result = await this.run(
      ref,
      asUser(opts.asUser, `[ -f ${quoted} ] || exit ${MISSING_FILE_EXIT}; ${read}`),
      { timeoutMs: 30_000 }
    );
    if (!result.ok) return null;
    const truncated = result.stdout.length > max;
    const content = truncated
      ? opts.fromEnd
        ? result.stdout.subarray(result.stdout.length - max)
        : result.stdout.subarray(0, max)
      : result.stdout;
    return { content, truncated };
  }

  async openPty(ref: SandboxRef, opts: PtyOptions): Promise<PtyHandle> {
    const pod = await this.requirePod(ref);
    const stdin = new PassThrough();
    const stdout = new ResizableOutput();
    stdout.setSize(opts.cols, opts.rows);
    const stderr = new PassThrough();
    const output = new PassThrough();
    stdout.on('data', (chunk: Buffer) => output.write(chunk));
    stderr.on('data', (chunk: Buffer) => output.write(chunk));
    let resolveExit!: (value: { ok: boolean; message: string | null }) => void;
    const exited = new Promise<{ ok: boolean; message: string | null }>((resolve) => {
      resolveExit = resolve;
    });
    let ended = false;
    const end = (value: { ok: boolean; message: string | null }) => {
      if (ended) return;
      ended = true;
      if (!output.writableEnded) output.end();
      resolveExit(value);
    };
    const socket = (await new k8s.Exec(this.kc).exec(
      this.namespace,
      pod.name,
      CONTAINER,
      opts.command,
      stdout,
      stderr,
      stdin,
      true,
      (status) => end({ ok: status?.status === 'Success', message: status?.message ?? null })
    )) as unknown as WebSocket;
    socket.on('close', () => {
      setTimeout(() => end({ ok: false, message: 'shell closed' }), 1000).unref?.();
    });
    return {
      stdin,
      output,
      resize: (cols, rows) => stdout.setSize(cols, rows),
      pause: () => output.pause(),
      resume: () => output.resume(),
      close: () => {
        try {
          socket.close();
        } catch {}
      },
      exited
    };
  }

  async httpTarget(ref: SandboxRef, port: number): Promise<HttpTarget> {
    if (process.env.SANDBOX_TUNNEL_MODE === 'portforward') return { kind: 'exec' };
    const ip = await this.resolvePodIp(ref);
    if (!ip) throw new SandboxNotRunningError('Sandbox pod has no address');
    return { kind: 'url', baseUrl: `http://${ip}:${port}`, headers: {} };
  }

  async openTcp(ref: SandboxRef, port: number): Promise<Duplex> {
    if (process.env.SANDBOX_TUNNEL_MODE === 'portforward') {
      const pod = await this.requirePod(ref);
      const input = new PassThrough();
      const output = new PassThrough();
      const socket = new PortForwardSocket(input, output);
      const ws = await new k8s.PortForward(this.kc).portForward(
        this.namespace,
        pod.name,
        [port],
        output,
        null,
        input
      );
      socket.attach(ws as unknown as WebSocket);
      return socket;
    }
    const ip = await this.resolvePodIp(ref);
    if (!ip) throw new SandboxNotRunningError('Sandbox pod has no address');
    const socket = net.connect(port, ip);
    socket.setNoDelay(true);
    return socket;
  }
}
