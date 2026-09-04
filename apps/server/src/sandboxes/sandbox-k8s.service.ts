import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { randomUUID } from 'crypto';
import { PassThrough } from 'stream';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { SANDBOX_BOOTSTRAP_SCRIPT } from './sandbox-bootstrap';
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
  SandboxCrStatus,
  readSandboxCr,
} from './sandbox-cr';

// How long a mirror heartbeat may go unwritten before its shard's picture of
// the cluster stops counting as current.
const MIRROR_FRESH_MS = 60_000;

export interface SandboxSpecInput {
  id: string;
  podName: string;
  userId: string;
  repoUrl: string | null;
  image: string;
  cpuLimit: string;
  memoryLimit: string;
  diskSize: string;
  setupScript?: string | null;
}

export interface SandboxSecretInput {
  authorizedKeys: string[];
  githubToken?: string | null;
  claudeToken?: string | null;
  openaiToken?: string | null;
  setupScript?: string | null;
  mcpToken?: string | null;
}

export function k8sErrorMessage(e: any): string {
  const body = e?.body ?? e?.response?.body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed?.message) return String(parsed.message);
    } catch {
      if (body.trim()) return body.slice(0, 300);
    }
  }
  if (body?.message) return String(body.message);
  return String(e?.message || 'unknown kubernetes error');
}

export function sandboxWorkdir(repoUrl: string | null): string {
  if (!repoUrl) return '/persist/home';
  const base = repoUrl.replace(/\.git$/, '').split('/').pop() || '';
  return base ? `/persist/home/${base}` : '/persist/home';
}

// A pod that is on its way out still reports Running for as long as it takes
// to stop, and exec'ing into one is a request that dies mid-flight.
function isPodLive(pod: any): boolean {
  return pod?.status?.phase === 'Running' && !pod?.metadata?.deletionTimestamp;
}

export function sandboxHomeMode(): 'block' | 'filesystem' {
  const mode = process.env.SANDBOX_HOME_MODE || 'auto';
  if (mode === 'block' || mode === 'filesystem') return mode;
  return process.env.SANDBOX_RUNTIME_CLASS ? 'block' : 'filesystem';
}

@Injectable()
export class SandboxK8sService {
  private readonly logger = new Logger(SandboxK8sService.name);

  private instanceIdCache: string | null = null;

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
  ) {}

  // Every sandbox resource carries the id of the install that made it. Several
  // Orchard servers (a laptop pointed at the cluster, a second install) can
  // share one sandbox namespace, and each one only ever sees its own database,
  // so without this an unknown podName looks like garbage to sweep up when it
  // is really another server's live sandbox.
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

  get namespace(): string {
    return process.env.SANDBOX_NAMESPACE || 'orchard-sandboxes';
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

  private secretName(podName: string): string {
    return `${podName}-auth`;
  }

  private async ensureNamespace(): Promise<void> {
    const core = this.core();
    let exists = true;
    try {
      await core.readNamespace(this.namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
      exists = false;
    }
    if (!exists) {
      try {
        await core.createNamespace({
          metadata: {
            name: this.namespace,
            labels: {
              'app.kubernetes.io/managed-by': 'Helm',
              'pod-security.kubernetes.io/enforce': 'privileged',
              'pod-security.kubernetes.io/audit': 'privileged',
              'pod-security.kubernetes.io/warn': 'privileged',
            },
            annotations: {
              'meta.helm.sh/release-name': 'orchard',
              'meta.helm.sh/release-namespace':
                process.env.ORCHARD_SERVER_NAMESPACE || 'orchard',
            },
          },
        });
        this.logger.log(`created sandbox namespace ${this.namespace}`);
      } catch (e: any) {
        if (e.response?.statusCode !== 409) throw e;
      }
    }
    await this.ensureNetworkPolicy();
  }

  private async ensureNetworkPolicy(): Promise<void> {
    const net = this.kc.makeApiClient(k8s.NetworkingV1Api);
    let existing: k8s.V1NetworkPolicy | null = null;
    try {
      const res = await net.readNamespacedNetworkPolicy('sandbox-isolation', this.namespace);
      existing = res.body;
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
    if (existing) {
      const ports = existing.spec?.ingress?.[0]?.ports?.map((p) => String(p.port)) ?? [];
      if (ports.includes('4096')) return;
      await net.deleteNamespacedNetworkPolicy('sandbox-isolation', this.namespace);
    }
    const serverNamespace = process.env.ORCHARD_SERVER_NAMESPACE || 'orchard';
    const policy: k8s.V1NetworkPolicy = {
      metadata: {
        name: 'sandbox-isolation',
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'Helm' },
        annotations: {
          'meta.helm.sh/release-name': 'orchard',
          'meta.helm.sh/release-namespace': serverNamespace,
        },
      },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': serverNamespace },
                },
                podSelector: {
                  matchLabels: { 'app.kubernetes.io/name': 'server' },
                },
              },
            ],
            ports: [
              { protocol: 'TCP', port: 22 as any },
              { protocol: 'TCP', port: 4096 as any },
            ],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 as any },
              { protocol: 'TCP', port: 53 as any },
            ],
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
                    '100.64.0.0/10',
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    try {
      await net.createNamespacedNetworkPolicy(this.namespace, policy);
      this.logger.log(`created sandbox-isolation network policy in ${this.namespace}`);
    } catch (e: any) {
      if (e.response?.statusCode !== 409) throw e;
    }
  }

  async ensureAuthSecret(spec: SandboxSpecInput, input: SandboxSecretInput): Promise<void> {
    const core = this.core();
    const instanceId = await this.instanceId();
    const name = this.secretName(spec.podName);
    const stringData: Record<string, string> = {
      authorized_keys: `${input.authorizedKeys.join('\n')}\n`,
      'bootstrap.sh': SANDBOX_BOOTSTRAP_SCRIPT,
    };
    if (input.githubToken) stringData['github-token'] = input.githubToken;
    if (input.claudeToken) stringData['claude-token'] = input.claudeToken;
    if (input.openaiToken) stringData['openai-token'] = input.openaiToken;
    stringData['setup.sh'] = input.setupScript || '';
    stringData['opencode-auth.json'] = input.claudeToken
      ? JSON.stringify({
          anthropic: {
            type: 'oauth',
            refresh: '',
            access: input.claudeToken,
            expires: 99999999999999,
          },
        })
      : '{}';
    const opencodeConfig: Record<string, any> = {
      plugin: ['@cortexkit/opencode-anthropic-auth'],
    };
    if (input.mcpToken && process.env.SANDBOX_MCP_URL) {
      opencodeConfig.mcp = {
        orchard: {
          type: 'remote',
          url: process.env.SANDBOX_MCP_URL,
          headers: { Authorization: `Bearer ${input.mcpToken}` },
          enabled: true,
        },
      };
    }
    stringData['opencode-config.json'] = JSON.stringify(opencodeConfig);
    const body: k8s.V1Secret = {
      metadata: {
        name,
        namespace: this.namespace,
        labels: this.labels(spec, instanceId),
      },
      type: 'Opaque',
      stringData,
    };
    try {
      await core.readNamespacedSecret(name, this.namespace);
      await core.replaceNamespacedSecret(name, this.namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
      await core.createNamespacedSecret(this.namespace, body);
    }
  }

  private labels(
    spec: Pick<SandboxSpecInput, 'id' | 'userId'>,
    instanceId: string,
  ): Record<string, string> {
    return {
      'app.kubernetes.io/name': 'sandbox',
      'app.kubernetes.io/managed-by': MANAGED_BY,
      [SANDBOX_ID_LABEL]: spec.id,
      'orchard.my/user-id': spec.userId,
      [INSTANCE_LABEL]: instanceId,
    };
  }

  private buildCr(spec: SandboxSpecInput, instanceId: string): Record<string, any> {
    const homeMode = sandboxHomeMode();
    const runtimeClass = process.env.SANDBOX_RUNTIME_CLASS || '';
    const container: Record<string, any> = {
      name: 'sandbox',
      image: spec.image,
      command: ['/bin/bash', '/orchard-init/bootstrap.sh'],
      ports: [{ containerPort: 22, name: 'ssh' }],
      env: [
        { name: 'SANDBOX_REPO_URL', value: spec.repoUrl || '' },
        { name: 'SANDBOX_HOME_MODE', value: homeMode },
        {
          name: 'GIT_TOKEN',
          valueFrom: {
            secretKeyRef: { name: this.secretName(spec.podName), key: 'github-token', optional: true },
          },
        },
        {
          name: 'CLAUDE_CODE_OAUTH_TOKEN',
          valueFrom: {
            secretKeyRef: { name: this.secretName(spec.podName), key: 'claude-token', optional: true },
          },
        },
        {
          name: 'OPENAI_API_KEY',
          valueFrom: {
            secretKeyRef: { name: this.secretName(spec.podName), key: 'openai-token', optional: true },
          },
        },
      ],
      resources: {
        requests: { cpu: '250m', memory: '512Mi' },
        limits: { cpu: spec.cpuLimit, memory: spec.memoryLimit },
      },
      volumeMounts: [
        {
          name: 'authkeys',
          mountPath: '/etc/ssh/authorized_keys.d',
          readOnly: true,
        },
        {
          name: 'init',
          mountPath: '/orchard-init',
          readOnly: true,
        },
      ],
    };
    if (homeMode === 'block') {
      container.volumeDevices = [{ name: 'home', devicePath: '/dev/sandboxhome' }];
      container.securityContext = { privileged: true };
    } else {
      container.volumeMounts.push({ name: 'home', mountPath: '/persist' });
    }
    return {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
      kind: 'Sandbox',
      metadata: {
        name: spec.podName,
        namespace: this.namespace,
        labels: this.labels(spec, instanceId),
      },
      spec: {
        operatingMode: 'Running',
        service: true,
        podTemplate: {
          metadata: { labels: this.labels(spec, instanceId) },
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
                  secretName: this.secretName(spec.podName),
                  items: [{ key: 'authorized_keys', path: 'authorized_keys' }],
                  defaultMode: 0o644,
                  optional: false,
                },
              },
              {
                name: 'init',
                secret: {
                  secretName: this.secretName(spec.podName),
                  items: [
                    { key: 'bootstrap.sh', path: 'bootstrap.sh' },
                    { key: 'setup.sh', path: 'setup.sh' },
                    { key: 'opencode-auth.json', path: 'opencode-auth.json' },
                    { key: 'opencode-config.json', path: 'opencode-config.json' },
                  ],
                  defaultMode: 0o644,
                  optional: false,
                },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: 'home', labels: this.labels(spec, instanceId) },
            spec: {
              accessModes: ['ReadWriteOnce'],
              volumeMode: sandboxHomeMode() === 'block' ? 'Block' : 'Filesystem',
              ...(process.env.SANDBOX_STORAGE_CLASS
                ? { storageClassName: process.env.SANDBOX_STORAGE_CLASS }
                : {}),
              resources: { requests: { storage: spec.diskSize } },
            },
          },
        ],
      },
    };
  }

  // Reports whether it made the resource. A 409 is not an error here: the
  // sandbox is meant to exist and it does, which leaves the caller to resume it
  // rather than to patch something it never confirmed was there.
  async createSandbox(spec: SandboxSpecInput, secret: SandboxSecretInput): Promise<boolean> {
    await this.ensureNamespace();
    await this.ensureAuthSecret(spec, secret);
    const instanceId = await this.instanceId();
    try {
      await this.custom().createNamespacedCustomObject(
        CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, this.buildCr(spec, instanceId),
      );
      return true;
    } catch (e: any) {
      if (e.response?.statusCode !== 409) throw e;
      return false;
    }
  }

  private async patchOperatingMode(
    podName: string,
    mode: 'Running' | 'Suspended',
  ): Promise<boolean> {
    try {
      await this.custom().patchNamespacedCustomObject(
        CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, podName,
        { spec: { operatingMode: mode } },
        undefined, undefined, undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } },
      );
      return true;
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
      return false;
    }
  }

  // A sandbox created before a platform change keeps the pod template it was
  // born with, so new secret volume items and env never appear. Re-render the
  // template from current code before resuming. The labels go with it so a
  // sandbox from before instance ids gets adopted by the install that runs it.
  async refreshSpec(spec: SandboxSpecInput): Promise<void> {
    const desired = this.buildCr(spec, await this.instanceId());
    await this.custom().patchNamespacedCustomObject(
      CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, spec.podName,
      {
        metadata: { labels: desired.metadata.labels },
        spec: { podTemplate: desired.spec.podTemplate },
      },
      undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
  }

  // Both report whether the resource was there to patch. Nothing downstream has
  // to look the sandbox up first to find that out, which is the only way to ask
  // the question without racing the answer.
  suspend(podName: string): Promise<boolean> {
    return this.patchOperatingMode(podName, 'Suspended');
  }

  resume(podName: string): Promise<boolean> {
    return this.patchOperatingMode(podName, 'Running');
  }

  async deleteSandbox(spec: Pick<SandboxSpecInput, 'id' | 'podName'>): Promise<void> {
    const custom = this.custom();
    const core = this.core();
    try {
      await custom.deleteNamespacedCustomObject(
        CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, spec.podName,
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
    try {
      await core.deleteNamespacedSecret(this.secretName(spec.podName), this.namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
    const pvcs = await core.listNamespacedPersistentVolumeClaim(
      this.namespace, undefined, undefined, undefined, undefined,
      `${SANDBOX_ID_LABEL}=${spec.id}`,
    );
    const claims = pvcs.body.items.length
      ? pvcs.body.items
      : (await core.listNamespacedPersistentVolumeClaim(this.namespace)).body.items.filter(
        (p) => p.metadata?.name?.includes(spec.podName),
      );
    for (const pvc of claims) {
      if (!pvc.metadata?.name) continue;
      try {
        await core.deleteNamespacedPersistentVolumeClaim(pvc.metadata.name, this.namespace);
      } catch (e: any) {
        if (e.response?.statusCode !== 404) throw e;
      }
    }
  }

  // The mirror is off on this replica, so every read has to go to the cluster.
  private get mirrorDisabled(): boolean {
    return process.env.MIRROR_DISABLED === 'true';
  }

  /**
   * Read from the mirror, not the apiserver. The informer holds every sandbox
   * resource this install owns and keeps it current from a watch, so asking
   * Postgres costs one indexed lookup where asking the cluster costs a round
   * trip per caller.
   *
   * `exists: false` from the mirror means "no such row", which only means "no
   * such resource" while the shard is actually reporting — see
   * canTrustCrAbsence(). Nothing destructive may run on it otherwise.
   */
  async getCrStatus(podName: string): Promise<SandboxCrStatus> {
    if (this.mirrorDisabled) return this.readCrFromCluster(podName);
    const row = await this.prisma.k8sObject.findUnique({
      where: {
        kind_namespace_name_apiVersion: {
          kind: CRD_KIND,
          namespace: this.namespace,
          name: podName,
          apiVersion: CRD_API_VERSION,
        },
      },
      select: { manifest: true },
    });
    return row ? readSandboxCr(row.manifest) : SANDBOX_CR_ABSENT;
  }

  private async readCrFromCluster(podName: string): Promise<SandboxCrStatus> {
    try {
      const res: any = await this.custom().getNamespacedCustomObject(
        CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, podName,
      );
      return readSandboxCr(res.body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) return SANDBOX_CR_ABSENT;
      throw e;
    }
  }

  // Whether a missing resource is a fact or just a gap in what we can see. A
  // direct read is its own evidence; a mirror read is only evidence while some
  // replica holds the shard, is heartbeating, has listed, and says its watch is
  // up. Every conclusion drawn from absence hangs on this.
  async canTrustCrAbsence(): Promise<boolean> {
    if (this.mirrorDisabled) return true;
    const row = await this.prisma.k8sMirrorHeartbeat.findUnique({
      where: { shard: SANDBOX_SHARD },
      select: { holder: true, healthy: true, lastListAt: true, updatedAt: true },
    });
    if (!row?.holder || !row.healthy || !row.lastListAt) return false;
    return Date.now() - row.updatedAt.getTime() < MIRROR_FRESH_MS;
  }

  async resolvePodIp(sandboxId: string, podName: string): Promise<string | null> {
    const status = await this.getCrStatus(podName);
    if (status.podIp) return status.podIp;
    const pod = await this.runningPod(sandboxId);
    return pod?.ip ?? null;
  }

  // The running pod for a sandbox, from the mirror when it has one and from the
  // apiserver when it does not. Exec, the SSH tunnel and the git panel all ask
  // for this on every request; a mirror hit spares the cluster a LIST each
  // time, and the fallback keeps the box reachable on an install whose mirror
  // is off or has not listed yet.
  private async runningPod(sandboxId: string): Promise<{ name: string; ip: string | null } | null> {
    const rows = this.mirrorDisabled
      ? []
      : await this.prisma.k8sObject.findMany({
        where: {
          kind: 'Pod',
          namespace: this.namespace,
          shard: SANDBOX_SHARD,
          manifest: { path: ['metadata', 'labels', SANDBOX_ID_LABEL], equals: sandboxId },
        },
        select: { manifest: true },
      });
    for (const row of rows) {
      const pod = row.manifest as any;
      if (!isPodLive(pod)) continue;
      return { name: String(pod.metadata.name), ip: pod.status.podIP ?? null };
    }
    const pods = await this.core().listNamespacedPod(
      this.namespace, undefined, undefined, undefined, undefined,
      `${SANDBOX_ID_LABEL}=${sandboxId}`,
    );
    const live = pods.body.items.find(isPodLive);
    if (!live?.metadata?.name) return null;
    return { name: live.metadata.name, ip: live.status?.podIP ?? null };
  }

  async execCapture(
    sandboxId: string,
    command: string[],
    timeoutMs = 15000,
  ): Promise<{ stdout: string; ok: boolean }> {
    const pod = await this.runningPod(sandboxId);
    if (!pod) throw new Error('sandbox pod is not running');
    const exec = new k8s.Exec(this.kc);
    const stdout = new PassThrough();
    let output = '';
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    return Promise.race([
      new Promise<{ stdout: string; ok: boolean }>((resolve, reject) => {
        exec.exec(
          this.namespace,
          pod.name,
          'sandbox',
          command,
          stdout,
          null,
          null,
          false,
          (status) => resolve({ stdout: output, ok: status.status === 'Success' }),
        ).catch(reject);
      }),
      new Promise<{ stdout: string; ok: boolean }>((_, reject) => {
        setTimeout(() => reject(new Error('sandbox command timed out')), timeoutMs);
      }),
    ]);
  }

  async isAgentBusy(sandboxId: string): Promise<boolean> {
    const pod = await this.runningPod(sandboxId);
    if (!pod) return false;
    try {
      const exec = new k8s.Exec(this.kc);
      const stdout = new PassThrough();
      let output = '';
      stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const result = await Promise.race([
        new Promise<boolean>((resolve, reject) => {
          exec.exec(
            this.namespace,
            pod.name,
            'sandbox',
            [
              '/bin/sh',
              '-c',
              "pgrep -af 'claude|codex' | grep -vE 'pgrep|opencode serve' | head -1; curl -s -m 3 http://127.0.0.1:4096/session/status | grep -o '\"type\":\"busy\"' | head -1",
            ],
            stdout,
            null,
            null,
            false,
            () => resolve(output.trim().length > 0),
          ).catch(reject);
        }),
        new Promise<boolean>((_, reject) => {
          setTimeout(() => reject(new Error('busy check timed out')), 5000);
        }),
      ]);
      return result;
    } catch (e: any) {
      this.logger.warn(`busy check failed for ${sandboxId}: ${e?.message}`);
      return false;
    }
  }
}
