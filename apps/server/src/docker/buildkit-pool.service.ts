import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { createHash } from 'crypto';
import { truncateKeepingSuffix } from '../projects/projects.utils';
import { loadKubeConfigFromPathOrBase64 } from '../kubernetes/kubeconfig';
import { BUILDER_NAMESPACE } from './builder-namespace';
import { buildArchNodeSelector } from './build-platform';
import {
  buildkitImageFor,
  effectiveSidecarPush,
  logBuildPosture,
  resolveBuildPosture,
  ROOTLESS_CONFIG_PATH,
  ROOTLESS_DOCKER_CONFIG,
  ROOTLESS_STATE_PATH,
  ROOTLESS_UID,
  rootlessContainerSecurityContext,
  type BuildPosture
} from './build-posture';
import {
  daemonTenantIngressPolicy,
  daemonTenantLabel,
  LEGACY_DAEMON_INGRESS_POLICY
} from './buildkit-daemon-policy';

const POSTURE_ANNOTATION = 'orchard.my/build-posture';

interface DaemonInfo {
  podName: string;
  podIp: string;
}

/**
 * Manages a pool of persistent BuildKit daemon pods. Each tenant (keyed by
 * cacheTenantKey, usually the project namespace) gets its own daemon pod that
 * stays alive between builds so the layer cache stays warm: matching what
 * Depot does under the hood.
 *
 * Lifecycle:
 *   1. getOrCreateDaemon(tenantKey) → finds or creates a buildkitd pod
 *   2. After the build client job completes, the daemon stays running
 *   3. reapIdleDaemons() deletes daemons unused for > maxIdleMs
 */
@Injectable()
export class BuildKitPoolService {
  private kc: k8s.KubeConfig | null = null;

  private readonly namespace: string;

  private readonly localCachePvc: string | undefined;

  private readonly dedicatedNodeEnabled: boolean;

  private readonly builderRuntimeClass: string | undefined;

  private readonly posture: BuildPosture = resolveBuildPosture();

  private readonly sidecarPushEnabled = effectiveSidecarPush(this.posture);

  constructor() {
    this.namespace = BUILDER_NAMESPACE;
    this.localCachePvc = process.env.BUILDKIT_LOCAL_CACHE_PVC;
    this.dedicatedNodeEnabled = process.env.BUILDER_DEDICATED_NODE === 'true';
    const rc = (process.env.BUILDER_RUNTIME_CLASS || '').trim();
    this.builderRuntimeClass = rc || undefined;
    logBuildPosture(this.posture, this.builderRuntimeClass);
    this.initKubeConfig();
  }

  private initKubeConfig() {
    try {
      this.kc = new k8s.KubeConfig();
      if (process.env.KUBECONFIG_BASE64) {
        let v = process.env.KUBECONFIG_BASE64.trim();
        while ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1).trim();
        }
        this.kc.loadFromString(Buffer.from(v, 'base64').toString('utf-8'));
      } else if (process.env.KUBECONFIG_PATH) {
        let p = process.env.KUBECONFIG_PATH.trim();
        while ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
          p = p.slice(1, -1).trim();
        }
        // KUBECONFIG_PATH also accepts the kubeconfig itself, base64 encoded,
        // see KubernetesService. Loading it as a path gives ENAMETOOLONG and
        // silently drops daemon mode back to daemonless on every build.
        loadKubeConfigFromPathOrBase64(this.kc, p);
      } else {
        this.kc.loadFromDefault();
      }
      console.log('[BuildKitPool] kubeconfig loaded');
    } catch (err) {
      console.error('[BuildKitPool] kubeconfig failed:', err.message);
      this.kc = null;
    }
  }

  private labelSelector(tenantKey: string): string {
    return `orchard.my/buildkit-daemon=true,orchard.my/tenant-key=${this.sanitizeLabel(tenantKey)}`;
  }

  private legacyLabelSelector(tenantKey: string): string {
    return `orchard.dev/buildkit-daemon=true,orchard.dev/tenant-key=${this.sanitizeLabel(tenantKey)}`;
  }

  private sanitizeLabel(v: string): string {
    return daemonTenantLabel(v);
  }

  private podName(tenantKey: string): string {
    const name = `buildkitd-${this.sanitizeLabel(tenantKey)}`;
    if (name.length < 63 && tenantKey.toLowerCase() === this.sanitizeLabel(tenantKey)) return name;
    const hash = createHash('sha256').update(tenantKey).digest('hex').slice(0, 8);
    return truncateKeepingSuffix(name, `-${hash}`);
  }

  /**
   * Return the IP of an existing ready daemon, or create one and wait for it.
   */
  async getOrCreateDaemon(tenantKey: string): Promise<DaemonInfo> {
    if (!this.kc) throw new Error('Kubernetes API not available');

    await this.ensureDaemonNetworkPolicy(tenantKey);

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const [existing, legacy] = await Promise.all([
      coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        this.labelSelector(tenantKey)
      ),
      coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        this.legacyLabelSelector(tenantKey)
      )
    ]);

    const stale: string[] = [];
    for (const pod of existing.body.items) {
      if (pod.metadata?.annotations?.[POSTURE_ANNOTATION] !== this.posture) {
        if (pod.metadata?.name) stale.push(pod.metadata.name);
        continue;
      }
      const phase = pod.status?.phase;
      const ip = pod.status?.podIP;
      const name = pod.metadata?.name;
      if (phase === 'Running' && ip && name) {
        await this.touchDaemon(name);
        console.log(`[BuildKitPool] Reusing daemon ${name} (${ip}) for tenant ${tenantKey}`);
        return { podName: name, podIp: ip };
      }
      if (phase === 'Pending' && name) {
        console.log(`[BuildKitPool] Found pending daemon ${name}, waiting...`);
        return this.waitForDaemonReady(name);
      }
    }

    for (const pod of legacy.body.items) {
      if (pod.metadata?.name) await this.retireLegacyDaemon(pod.metadata.name);
    }
    for (const name of stale) await this.retireLegacyDaemon(name);

    return this.createDaemon(tenantKey);
  }

  private async retireLegacyDaemon(podName: string): Promise<void> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    console.log(`[BuildKitPool] Replacing legacy-labelled daemon ${podName}`);
    try {
      await coreApi.deleteNamespacedPod(podName, this.namespace);
    } catch (err) {
      if ((err.statusCode ?? err.response?.statusCode) !== 404) throw err;
      return;
    }
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        await coreApi.readNamespacedPod(podName, this.namespace);
      } catch (err) {
        if ((err.statusCode ?? err.response?.statusCode) === 404) return;
        throw err;
      }
      await new Promise((r) => {
        setTimeout(r, 2000);
      });
    }
    throw new Error(`Legacy daemon pod ${podName} did not terminate in time`);
  }

  // buildkitd's tcp addr has no auth of its own: anything that can route to
  // the pod can run builds and read the tenant's layer cache. Each daemon gets
  // its own policy admitting only build pods carrying the same tenant key.
  private async ensureDaemonNetworkPolicy(tenantKey: string): Promise<void> {
    const networkingApi = this.kc!.makeApiClient(k8s.NetworkingV1Api);
    const body = daemonTenantIngressPolicy({
      namespace: this.namespace,
      name: `${this.podName(tenantKey)}-ingress`,
      tenantLabel: this.sanitizeLabel(tenantKey)
    });
    const name = body.metadata!.name!;

    try {
      await networkingApi.deleteNamespacedNetworkPolicy(
        LEGACY_DAEMON_INGRESS_POLICY,
        this.namespace
      );
    } catch (err) {
      if ((err.statusCode ?? err.response?.statusCode) !== 404) throw err;
    }

    try {
      await networkingApi.readNamespacedNetworkPolicy(name, this.namespace);
      await networkingApi.replaceNamespacedNetworkPolicy(name, this.namespace, body);
    } catch (err) {
      if ((err.statusCode ?? err.response?.statusCode) === 404) {
        await networkingApi.createNamespacedNetworkPolicy(this.namespace, body);
      } else {
        throw err;
      }
    }
  }

  daemonPodSpec(name: string, sanitizedKey: string): k8s.V1Pod {
    const rootless = this.posture === 'rootless';
    const statePath = rootless ? ROOTLESS_STATE_PATH : '/var/lib/buildkit';
    const dockerConfigPath = rootless ? ROOTLESS_DOCKER_CONFIG : '/root/.docker';
    const stateVolume = {
      name: 'buildkit-state',
      ...(this.localCachePvc
        ? { persistentVolumeClaim: { claimName: this.localCachePvc } }
        : { emptyDir: {} })
    };

    return {
      metadata: {
        name,
        namespace: this.namespace,
        labels: {
          'orchard.my/buildkit-daemon': 'true',
          'orchard.my/tenant-key': sanitizedKey,
          'app.kubernetes.io/name': 'buildkit-daemon',
          'app.kubernetes.io/managed-by': 'orchard'
        },
        annotations: {
          'orchard.my/last-used': new Date().toISOString(),
          [POSTURE_ANNOTATION]: this.posture,
          ...(rootless
            ? { 'container.apparmor.security.beta.kubernetes.io/buildkitd': 'unconfined' }
            : {})
        }
      },
      spec: {
        restartPolicy: 'Always',
        automountServiceAccountToken: false,
        ...(this.builderRuntimeClass ? { runtimeClassName: this.builderRuntimeClass } : {}),
        nodeSelector: {
          ...buildArchNodeSelector(),
          ...(this.dedicatedNodeEnabled ? { 'orchard-builder': 'true' } : {})
        },
        ...(this.dedicatedNodeEnabled
          ? {
              tolerations: [
                {
                  key: 'orchard-builder',
                  operator: 'Exists' as const,
                  effect: 'NoSchedule' as const
                }
              ]
            }
          : {}),
        ...(rootless
          ? {
              initContainers: [
                {
                  name: 'own-state',
                  image: 'alpine:latest',
                  command: ['/bin/sh', '-c'],
                  args: [`chown -R ${ROOTLESS_UID}:${ROOTLESS_UID} /state`],
                  securityContext: { runAsUser: 0, allowPrivilegeEscalation: false },
                  volumeMounts: [
                    { name: 'buildkit-state', mountPath: '/state', subPath: sanitizedKey }
                  ],
                  resources: {
                    requests: { cpu: '50m', memory: '64Mi' },
                    limits: { cpu: '500m', memory: '256Mi' }
                  }
                }
              ]
            }
          : {}),
        containers: [
          {
            name: 'buildkitd',
            image: buildkitImageFor(this.posture),
            args: rootless
              ? [
                  '--addr',
                  'tcp://0.0.0.0:1234',
                  '--config',
                  ROOTLESS_CONFIG_PATH,
                  '--oci-worker-no-process-sandbox'
                ]
              : ['--addr', 'tcp://0.0.0.0:1234', '--addr', 'unix:///run/buildkit/buildkitd.sock'],
            securityContext: rootless ? rootlessContainerSecurityContext() : { privileged: true },
            ports: [{ containerPort: 1234, name: 'buildkit', protocol: 'TCP' }],
            readinessProbe: {
              exec: {
                command: rootless
                  ? ['buildctl', '--addr', 'tcp://127.0.0.1:1234', 'debug', 'workers']
                  : ['buildctl', 'debug', 'workers']
              },
              initialDelaySeconds: 3,
              periodSeconds: 10
            },
            ...(this.sidecarPushEnabled
              ? {}
              : { env: [{ name: 'DOCKER_CONFIG', value: dockerConfigPath }] }),
            volumeMounts: [
              {
                name: 'buildkit-state',
                mountPath: statePath,
                subPath: sanitizedKey
              },
              {
                name: 'buildkit-config',
                mountPath: '/etc/buildkit',
                readOnly: true
              },
              ...(this.sidecarPushEnabled
                ? []
                : [{ name: 'docker-config', mountPath: dockerConfigPath, readOnly: true }])
            ],
            resources: {
              requests: { cpu: '250m', memory: '1Gi' },
              limits: { cpu: '4', memory: '16Gi' }
            }
          }
        ],
        volumes: [
          stateVolume,
          {
            name: 'buildkit-config',
            configMap: { name: 'buildkit-config' }
          },
          ...(this.sidecarPushEnabled
            ? []
            : [
                {
                  name: 'docker-config',
                  secret: {
                    secretName: process.env.REGISTRY_PULL_SECRET_NAME || 'harbor-registry-creds',
                    items: [{ key: '.dockerconfigjson', path: 'config.json' }]
                  }
                }
              ])
        ]
      }
    };
  }

  private async createDaemon(tenantKey: string): Promise<DaemonInfo> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    const name = this.podName(tenantKey);
    const sanitizedKey = this.sanitizeLabel(tenantKey);

    console.log(`[BuildKitPool] Creating daemon pod ${name} for tenant ${tenantKey}`);

    const pod = this.daemonPodSpec(name, sanitizedKey);

    try {
      await coreApi.createNamespacedPod(this.namespace, pod);
    } catch (err) {
      // If pod already exists (race condition), just wait for it
      if (err.statusCode === 409) {
        console.log(`[BuildKitPool] Daemon ${name} already exists (race), waiting...`);
      } else {
        throw err;
      }
    }

    return this.waitForDaemonReady(name);
  }

  private async waitForDaemonReady(podName: string, timeoutMs = 120_000): Promise<DaemonInfo> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await coreApi.readNamespacedPod(podName, this.namespace);
        const pod = res.body;
        const phase = pod.status?.phase;
        const ip = pod.status?.podIP;

        if (phase === 'Running' && ip) {
          const ready = pod.status?.containerStatuses?.every((c) => c.ready) ?? false;
          if (ready) {
            console.log(`[BuildKitPool] Daemon ${podName} ready at ${ip}`);
            return { podName, podIp: ip };
          }
        }

        if (phase === 'Failed' || phase === 'Unknown') {
          throw new Error(`Daemon pod ${podName} in ${phase} state`);
        }
      } catch (err) {
        if (err.statusCode === 404) {
          throw new Error(`Daemon pod ${podName} not found`);
        }
        if (err.message?.includes('state')) throw err;
      }

      await new Promise((r) => {
        setTimeout(r, 3000);
      });
    }

    throw new Error(`Daemon pod ${podName} not ready after ${timeoutMs / 1000}s`);
  }

  private async touchDaemon(podName: string): Promise<void> {
    if (!this.kc) return;
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      await coreApi.patchNamespacedPod(
        podName,
        this.namespace,
        { metadata: { annotations: { 'orchard.my/last-used': new Date().toISOString() } } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } catch (err) {
      console.warn(`[BuildKitPool] Failed to touch daemon ${podName}:`, err.message);
    }
  }

  /**
   * Delete daemon pods that haven't been used within maxIdleMs.
   * Call this periodically (e.g. every 5 minutes via setInterval).
   */
  async reapIdleDaemons(maxIdleMs = 120 * 60_000): Promise<void> {
    if (!this.kc) return;
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      const [pods, legacyPods] = await Promise.all([
        coreApi.listNamespacedPod(
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          'orchard.my/buildkit-daemon=true'
        ),
        coreApi.listNamespacedPod(
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          'orchard.dev/buildkit-daemon=true'
        )
      ]);

      const now = Date.now();
      const seen = new Set<string>();
      for (const pod of [...pods.body.items, ...legacyPods.body.items]) {
        const annotations = pod.metadata?.annotations;
        const lastUsed =
          annotations?.['orchard.my/last-used'] ?? annotations?.['orchard.dev/last-used'];
        const name = pod.metadata?.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const lastUsedMs = lastUsed ? new Date(lastUsed).getTime() : 0;
        const idleMs = now - lastUsedMs;

        if (idleMs > maxIdleMs) {
          console.log(
            `[BuildKitPool] Reaping idle daemon ${name} (idle ${Math.round(idleMs / 60_000)}m)`
          );
          try {
            await coreApi.deleteNamespacedPod(name, this.namespace);
          } catch (err) {
            if (err.statusCode !== 404) {
              console.error(`[BuildKitPool] Failed to delete daemon ${name}:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error('[BuildKitPool] reapIdleDaemons error:', err.message);
    }
  }

  async deleteDaemon(tenantKey: string): Promise<void> {
    if (!this.kc) return;
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const name = this.podName(tenantKey);
    try {
      await coreApi.deleteNamespacedPod(name, this.namespace);
      console.log(`[BuildKitPool] Deleted daemon ${name}`);
    } catch (err) {
      if (err.statusCode !== 404) {
        console.error(`[BuildKitPool] Failed to delete daemon ${name}:`, err.message);
      }
    }
  }
}
