import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';

interface DaemonInfo {
  podName: string;
  podIp: string;
}

/**
 * Manages a pool of persistent BuildKit daemon pods. Each tenant (keyed by
 * cacheTenantKey, usually the project namespace) gets its own daemon pod that
 * stays alive between builds so the layer cache stays warm — matching what
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

  constructor() {
    this.namespace = process.env.BUILDER_NAMESPACE || 'orchard-builders';
    this.localCachePvc = process.env.BUILDKIT_LOCAL_CACHE_PVC;
    this.dedicatedNodeEnabled = process.env.BUILDER_DEDICATED_NODE === 'true';
    const rc = (process.env.BUILDER_RUNTIME_CLASS || '').trim();
    this.builderRuntimeClass = rc || undefined;
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
        this.kc.loadFromFile(p);
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
    return `orchard.dev/buildkit-daemon=true,orchard.dev/tenant-key=${this.sanitizeLabel(tenantKey)}`;
  }

  private sanitizeLabel(v: string): string {
    return v.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
  }

  private podName(tenantKey: string): string {
    return `buildkitd-${this.sanitizeLabel(tenantKey)}`.slice(0, 63);
  }

  /**
   * Return the IP of an existing ready daemon, or create one and wait for it.
   */
  async getOrCreateDaemon(tenantKey: string): Promise<DaemonInfo> {
    if (!this.kc) throw new Error('Kubernetes API not available');

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    // Look for an existing daemon pod
    const existing = await coreApi.listNamespacedPod(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      this.labelSelector(tenantKey),
    );

    for (const pod of existing.body.items) {
      const phase = pod.status?.phase;
      const ip = pod.status?.podIP;
      const name = pod.metadata?.name;
      if (phase === 'Running' && ip && name) {
        // Touch last-used timestamp
        await this.touchDaemon(name);
        console.log(`[BuildKitPool] Reusing daemon ${name} (${ip}) for tenant ${tenantKey}`);
        return { podName: name, podIp: ip };
      }
      // If pending, wait for it below
      if (phase === 'Pending' && name) {
        console.log(`[BuildKitPool] Found pending daemon ${name}, waiting...`);
        return this.waitForDaemonReady(name);
      }
    }

    // No daemon exists — create one
    return this.createDaemon(tenantKey);
  }

  private async createDaemon(tenantKey: string): Promise<DaemonInfo> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    const name = this.podName(tenantKey);
    const sanitizedKey = this.sanitizeLabel(tenantKey);

    console.log(`[BuildKitPool] Creating daemon pod ${name} for tenant ${tenantKey}`);

    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: this.namespace,
        labels: {
          'orchard.dev/buildkit-daemon': 'true',
          'orchard.dev/tenant-key': sanitizedKey,
          'app.kubernetes.io/name': 'buildkit-daemon',
          'app.kubernetes.io/managed-by': 'orchard',
        },
        annotations: {
          'orchard.dev/last-used': new Date().toISOString(),
        },
      },
      spec: {
        restartPolicy: 'Always',
        automountServiceAccountToken: false,
        ...(this.builderRuntimeClass ? { runtimeClassName: this.builderRuntimeClass } : {}),
        ...(this.dedicatedNodeEnabled ? {
          nodeSelector: { 'orchard-builder': 'true' },
          tolerations: [{
            key: 'orchard-builder',
            operator: 'Exists' as const,
            effect: 'NoSchedule' as const,
          }],
        } : {}),
        containers: [
          {
            name: 'buildkitd',
            image: 'moby/buildkit:latest',
            args: [
              '--addr', 'tcp://0.0.0.0:1234',
              '--addr', 'unix:///run/buildkit/buildkitd.sock',
            ],
            securityContext: { privileged: true },
            ports: [{ containerPort: 1234, name: 'buildkit', protocol: 'TCP' }],
            readinessProbe: {
              exec: { command: ['buildctl', 'debug', 'workers'] },
              initialDelaySeconds: 3,
              periodSeconds: 10,
            },
            env: [
              { name: 'DOCKER_CONFIG', value: '/root/.docker' },
            ],
            volumeMounts: [
              {
                name: 'buildkit-state',
                mountPath: '/var/lib/buildkit',
                subPath: sanitizedKey,
              },
              {
                name: 'buildkit-config',
                mountPath: '/etc/buildkit',
                readOnly: true,
              },
              {
                name: 'docker-config',
                mountPath: '/root/.docker',
                readOnly: true,
              },
            ],
            resources: {
              requests: { cpu: '250m', memory: '1Gi' },
              limits: { cpu: '4', memory: '16Gi' },
            },
          },
        ],
        volumes: [
          {
            name: 'buildkit-state',
            ...(this.localCachePvc
              ? { persistentVolumeClaim: { claimName: this.localCachePvc } }
              : { emptyDir: {} }),
          },
          {
            name: 'buildkit-config',
            configMap: { name: 'buildkit-config' },
          },
          {
            name: 'docker-config',
            secret: {
              secretName: 'harbor-registry-creds',
              items: [{ key: '.dockerconfigjson', path: 'config.json' }],
            },
          },
        ],
      },
    };

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
          // Check readiness
          const ready = pod.status?.containerStatuses?.every(c => c.ready) ?? false;
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

      await new Promise(r => setTimeout(r, 3000));
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
        { metadata: { annotations: { 'orchard.dev/last-used': new Date().toISOString() } } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
      );
    } catch (err) {
      console.warn(`[BuildKitPool] Failed to touch daemon ${podName}:`, err.message);
    }
  }

  /**
   * Delete daemon pods that haven't been used within maxIdleMs.
   * Call this periodically (e.g. every 5 minutes via setInterval).
   */
  async reapIdleDaemons(maxIdleMs = 30 * 60_000): Promise<void> {
    if (!this.kc) return;
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      const pods = await coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'orchard.dev/buildkit-daemon=true',
      );

      const now = Date.now();
      for (const pod of pods.body.items) {
        const lastUsed = pod.metadata?.annotations?.['orchard.dev/last-used'];
        const name = pod.metadata?.name;
        if (!name) continue;

        const lastUsedMs = lastUsed ? new Date(lastUsed).getTime() : 0;
        const idleMs = now - lastUsedMs;

        if (idleMs > maxIdleMs) {
          console.log(`[BuildKitPool] Reaping idle daemon ${name} (idle ${Math.round(idleMs / 60_000)}m)`);
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

  /**
   * Delete the daemon pod for a specific tenant.
   */
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
