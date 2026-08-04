import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { SANDBOX_BOOTSTRAP_SCRIPT } from './sandbox-bootstrap';

const CRD_GROUP = 'agents.x-k8s.io';
const CRD_VERSION = 'v1beta1';
const CRD_PLURAL = 'sandboxes';
const MANAGED_BY = 'orchard-sandbox';

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
}

export interface SandboxCrStatus {
  exists: boolean;
  operatingMode: 'Running' | 'Suspended' | null;
  ready: boolean;
  message: string | null;
  podIp: string | null;
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

export function sandboxHomeMode(): 'block' | 'filesystem' {
  const mode = process.env.SANDBOX_HOME_MODE || 'auto';
  if (mode === 'block' || mode === 'filesystem') return mode;
  return process.env.SANDBOX_RUNTIME_CLASS ? 'block' : 'filesystem';
}

@Injectable()
export class SandboxK8sService {
  private readonly logger = new Logger(SandboxK8sService.name);

  constructor(private readonly kubernetes: KubernetesService) {}

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
    try {
      await net.readNamespacedNetworkPolicy('sandbox-isolation', this.namespace);
      return;
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
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
            ports: [{ protocol: 'TCP', port: 22 as any }],
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
    const name = this.secretName(spec.podName);
    const stringData: Record<string, string> = {
      authorized_keys: `${input.authorizedKeys.join('\n')}\n`,
      'bootstrap.sh': SANDBOX_BOOTSTRAP_SCRIPT,
    };
    if (input.githubToken) stringData['github-token'] = input.githubToken;
    if (input.claudeToken) stringData['claude-token'] = input.claudeToken;
    if (input.openaiToken) stringData['openai-token'] = input.openaiToken;
    stringData['setup.sh'] = input.setupScript || '';
    const body: k8s.V1Secret = {
      metadata: {
        name,
        namespace: this.namespace,
        labels: this.labels(spec),
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

  private labels(spec: Pick<SandboxSpecInput, 'id' | 'userId'>): Record<string, string> {
    return {
      'app.kubernetes.io/name': 'sandbox',
      'app.kubernetes.io/managed-by': MANAGED_BY,
      'orchard.my/sandbox-id': spec.id,
      'orchard.my/user-id': spec.userId,
    };
  }

  private buildCr(spec: SandboxSpecInput): Record<string, any> {
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
        labels: this.labels(spec),
      },
      spec: {
        operatingMode: 'Running',
        service: true,
        podTemplate: {
          metadata: { labels: this.labels(spec) },
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
            metadata: { name: 'home', labels: this.labels(spec) },
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

  async createSandbox(spec: SandboxSpecInput, secret: SandboxSecretInput): Promise<void> {
    await this.ensureNamespace();
    await this.ensureAuthSecret(spec, secret);
    try {
      await this.custom().createNamespacedCustomObject(
        CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, this.buildCr(spec),
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 409) throw e;
    }
  }

  private async patchOperatingMode(podName: string, mode: 'Running' | 'Suspended'): Promise<void> {
    await this.custom().patchNamespacedCustomObject(
      CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, podName,
      { spec: { operatingMode: mode } },
      undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
  }

  async suspend(podName: string): Promise<void> {
    await this.patchOperatingMode(podName, 'Suspended');
  }

  async resume(podName: string): Promise<void> {
    await this.patchOperatingMode(podName, 'Running');
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
      `orchard.my/sandbox-id=${spec.id}`,
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

  async getCrStatus(podName: string): Promise<SandboxCrStatus> {
    try {
      const res: any = await this.custom().getNamespacedCustomObject(
        CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL, podName,
      );
      const cr = res.body;
      const conditions: Array<{ type?: string; status?: string; message?: string }> =
        cr.status?.conditions || [];
      const ready = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
      const failing = conditions.find((c) => c.status === 'False' && c.message);
      return {
        exists: true,
        operatingMode: cr.spec?.operatingMode === 'Suspended' ? 'Suspended' : 'Running',
        ready,
        message: failing?.message || null,
        podIp: Array.isArray(cr.status?.podIPs) && cr.status.podIPs.length
          ? String(cr.status.podIPs[0])
          : null,
      };
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        return { exists: false, operatingMode: null, ready: false, message: null, podIp: null };
      }
      throw e;
    }
  }

  async listCrNames(): Promise<string[]> {
    const res: any = await this.custom().listNamespacedCustomObject(
      CRD_GROUP, CRD_VERSION, this.namespace, CRD_PLURAL,
    );
    return (res.body.items || [])
      .map((i: any) => i.metadata?.name)
      .filter(Boolean);
  }

  async resolvePodIp(sandboxId: string, podName: string): Promise<string | null> {
    const status = await this.getCrStatus(podName);
    if (status.podIp) return status.podIp;
    const pods = await this.core().listNamespacedPod(
      this.namespace, undefined, undefined, undefined, undefined,
      `orchard.my/sandbox-id=${sandboxId}`,
    );
    const running = pods.body.items.find((p) => p.status?.phase === 'Running');
    return running?.status?.podIP || null;
  }

  async execCapture(
    sandboxId: string,
    command: string[],
    timeoutMs = 15000,
  ): Promise<{ stdout: string; ok: boolean }> {
    const pods = await this.core().listNamespacedPod(
      this.namespace, undefined, undefined, undefined, undefined,
      `orchard.my/sandbox-id=${sandboxId}`,
    );
    const pod = pods.body.items.find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) throw new Error('sandbox pod is not running');
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
          pod.metadata!.name!,
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
    const pods = await this.core().listNamespacedPod(
      this.namespace, undefined, undefined, undefined, undefined,
      `orchard.my/sandbox-id=${sandboxId}`,
    );
    const pod = pods.body.items.find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) return false;
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
            pod.metadata!.name!,
            'sandbox',
            ['/bin/sh', '-c', "pgrep -f 'claude|codex' | grep -v pgrep | head -1"],
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
