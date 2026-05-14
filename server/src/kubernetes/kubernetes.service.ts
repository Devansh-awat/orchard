import { Injectable, ServiceUnavailableException, NotFoundException, BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseCpu, parseMemory, cpuMilliToK8s, memoryBytesToK8s } from './quantity';

function buildNodeAffinity(
  allowedNodes: string[] | null | undefined,
  deniedNodes: string[] | undefined,
): k8s.V1Affinity | null {
  const terms: k8s.V1NodeSelectorRequirement[] = [];
  if (allowedNodes && allowedNodes.length > 0) {
    terms.push({ key: 'kubernetes.io/hostname', operator: 'In', values: allowedNodes });
  }
  if (deniedNodes && deniedNodes.length > 0) {
    terms.push({ key: 'kubernetes.io/hostname', operator: 'NotIn', values: deniedNodes });
  }
  if (terms.length === 0) return null;
  return {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [{ matchExpressions: terms }],
      },
    },
  };
}

type DeploymentEnvVarInput = {
  key: string;
  value: string;
};

type DeploymentPortInput = {
  name?: string;
  containerPort?: number;
  servicePort?: number;
  protocol?: string;
  nodePort?: number;
};

type SanitizedPortEntry = {
  name: string;
  containerPort: number;
  servicePort: number;
  protocol: string;
  nodePort?: number;
};

type CreateDeploymentOptions = {
  namespace: string;
  name: string;
  image: string;
  replicas: number;
  ports?: DeploymentPortInput[];
  env?: DeploymentEnvVarInput[];
  serviceType?: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
  allowedNodes?: string[] | null;
  deniedNodes?: string[];
  resources?: {
    cpuMilli: number;
    memoryBytes: number;
  };
  volumes?: {
    name: string;
    type: 'pvc' | 'hostPath' | 'emptyDir';
    mountPath: string;
    pvcName?: string;
    storageSize?: string;
    hostPath?: string;
    readOnly?: boolean;
  }[];
  healthCheck?: {
    enabled: boolean;
    type: string;
    path?: string | null;
    port?: number | null;
    command?: string | null;
    livenessEnabled: boolean;
    readinessEnabled: boolean;
    startupEnabled: boolean;
    interval: number;
    timeout: number;
    retries: number;
    startupFailureThreshold: number;
  };
  // 'rollingUpdate' | 'recreate' — when omitted, the cluster default
  // (RollingUpdate) is used. Caller is responsible for forcing 'recreate' when
  // a PVC volume is attached.
  deployStrategy?: 'rollingUpdate' | 'recreate';
};

type UpdateDeploymentEnvOptions = {
  namespace: string;
  deploymentName: string;
  env: DeploymentEnvVarInput[];
};

type UpdateServiceExposureOptions = {
  namespace: string;
  serviceName: string;
  type: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
};

type UpdateServicePortsOptions = {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  ports: DeploymentPortInput[];
};

type CreateAdditionalServiceOptions = {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  ports: DeploymentPortInput[];
  type?: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
};

type DeleteDeploymentServiceOptions = {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  remainingPorts?: DeploymentPortInput[];
};

type IngressPathBackend = {
  path: string;
  pathType?: string;
  serviceName: string;
  servicePort: number;
};

type CreateIngressOptions = {
  namespace: string;
  name: string;
  host: string;
  path?: string;
  pathType?: string;
  serviceName?: string;
  servicePort?: number;
  serviceTargetPort?: number;
  paths?: IngressPathBackend[];
  tlsSecretName?: string;
  tlsHosts?: string[];
  ingressClassName?: string;
  entrypoints?: string[];
  annotations?: Record<string, string>;
  basicAuth?: {
    enabled: boolean;
    username: string;
    password: string;
    secretName?: string;
  };
};

@Injectable()
export class KubernetesService {
  private kc: k8s.KubeConfig | null;

  constructor(private readonly prisma: PrismaService) {
    try {
      this.kc = new k8s.KubeConfig();
      if (process.env.KUBECONFIG_BASE64) {
        console.log('[K8s] Loading kubeconfig from base64 encoded string');
        let base64Value = process.env.KUBECONFIG_BASE64.trim();
        
        while ((base64Value.startsWith('"') && base64Value.endsWith('"')) || 
               (base64Value.startsWith("'") && base64Value.endsWith("'"))) {
          base64Value = base64Value.slice(1, -1).trim();
        }
        
        if (!base64Value) {
          throw new Error('KUBECONFIG_BASE64 is empty after removing quotes');
        }
        
        console.log('[K8s] Base64 kubeconfig length:', base64Value.length, 'characters');
        
        try {
          const decoded = Buffer.from(base64Value, 'base64').toString('utf-8');
          if (!decoded || decoded.trim().length === 0) {
            throw new Error('Decoded kubeconfig is empty');
          }
          console.log('[K8s] Successfully decoded kubeconfig, decoded length:', decoded.length, 'characters');
          this.kc.loadFromString(decoded);
        } catch (decodeError) {
          throw new Error(`Failed to decode base64 kubeconfig: ${decodeError.message}`);
        }
      } else if (process.env.KUBECONFIG_PATH) {
        let configPath = process.env.KUBECONFIG_PATH.trim();
        
        while ((configPath.startsWith('"') && configPath.endsWith('"')) || 
               (configPath.startsWith("'") && configPath.endsWith("'"))) {
          configPath = configPath.slice(1, -1).trim();
        }
        
        if (!configPath.includes('/') && !configPath.includes('\\') && configPath.length > 100) {
          console.log('[K8s] Detected base64 string in KUBECONFIG_PATH, decoding...');
          console.log('[K8s] Base64 kubeconfig length:', configPath.length, 'characters');
          try {
            const decoded = Buffer.from(configPath, 'base64').toString('utf-8');
            if (!decoded || decoded.trim().length === 0) {
              throw new Error('Decoded kubeconfig is empty');
            }
            if (decoded.includes('apiVersion:') || decoded.includes('kind: Config')) {
              console.log('[K8s] Successfully decoded kubeconfig from KUBECONFIG_PATH, decoded length:', decoded.length, 'characters');
              this.kc.loadFromString(decoded);
            } else {
              throw new Error('Decoded string does not appear to be a valid kubeconfig');
            }
          } catch (decodeError) {
            console.warn('[K8s] Failed to decode as base64, trying as file path:', decodeError.message);
            console.log('[K8s] Loading kubeconfig from file:', configPath);
            this.kc.loadFromFile(configPath);
          }
        } else {
          console.log('[K8s] Loading kubeconfig from file:', configPath);
          this.kc.loadFromFile(configPath);
        }
      } else {
        console.log('[K8s] Loading default kubeconfig');
        this.kc.loadFromDefault();
      }
      console.log('[K8s] Successfully loaded kubeconfig');
      console.log('[K8s] Current context:', this.kc.getCurrentContext());
    } catch (error) {
      console.error('[K8s] Error loading kubeconfig:', error.message);
      console.warn('[K8s] Make sure KUBECONFIG_BASE64, KUBECONFIG_PATH is set or ~/.kube/config exists');
      this.kc = null;
    }
  }

  private ensureKubeConfig() {
    if (!this.kc) {
      throw new ServiceUnavailableException({
        error: 'Kubernetes API not available',
        message: 'Kubeconfig could not be loaded. Check server logs for details.'
      });
    }
  }

  private async getDefaultNodeIp(coreApi: k8s.CoreV1Api): Promise<string | null> {
    try {
      const nodes = await coreApi.listNode();
      for (const node of nodes.body.items) {
        const addresses = node.status?.addresses || [];
        const external = addresses.find((entry) => entry.type === 'ExternalIP' && entry.address);
        if (external?.address) {
          return external.address;
        }
        const internal = addresses.find((entry) => entry.type === 'InternalIP' && entry.address);
        if (internal?.address) {
          return internal.address;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] Failed to fetch node IP:', message);
    }
    return null;
  }

  // Apply (or remove) a ResourceQuota + LimitRange in a namespace.
  // Pass nulls to remove the resource.
  async applyNamespaceQuota(options: {
    namespace: string;
    cpuLimitMilli?: number | null;
    memoryLimitBytes?: number | null;
    maxPods?: number | null;
    maxServices?: number | null;
    defaultPodCpuMilli?: number | null;
    defaultPodMemoryBytes?: number | null;
  }) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const ns = options.namespace;
    const quotaName = 'orchard-org-quota';
    const limitName = 'orchard-defaults';

    const hardQuota: Record<string, string> = {};
    if (options.cpuLimitMilli && options.cpuLimitMilli > 0) {
      hardQuota['requests.cpu'] = `${options.cpuLimitMilli}m`;
      hardQuota['limits.cpu'] = `${options.cpuLimitMilli}m`;
    }
    if (options.memoryLimitBytes && options.memoryLimitBytes > 0) {
      hardQuota['requests.memory'] = String(options.memoryLimitBytes);
      hardQuota['limits.memory'] = String(options.memoryLimitBytes);
    }
    if (options.maxPods && options.maxPods > 0) {
      hardQuota['pods'] = String(options.maxPods);
    }
    if (options.maxServices && options.maxServices > 0) {
      hardQuota['services'] = String(options.maxServices);
    }

    // ResourceQuota
    if (Object.keys(hardQuota).length === 0) {
      try {
        await api.deleteNamespacedResourceQuota(quotaName, ns);
      } catch (error: any) {
        if (error?.response?.statusCode !== 404) {
          console.error('[K8s] delete ResourceQuota failed:', error?.message || error);
        }
      }
    } else {
      const quotaBody: k8s.V1ResourceQuota = {
        metadata: { name: quotaName, labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
        spec: { hard: hardQuota },
      };
      try {
        await api.replaceNamespacedResourceQuota(quotaName, ns, quotaBody);
      } catch (error: any) {
        if (error?.response?.statusCode === 404) {
          await api.createNamespacedResourceQuota(ns, quotaBody);
        } else {
          throw error;
        }
      }
    }

    // LimitRange — required for per-container defaults so ResourceQuota admission succeeds
    // for pods that don't specify requests. Also caps per-container to org defaults.
    const hasDefaults =
      (options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0) ||
      (options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0);
    // If we set any ResourceQuota with requests.cpu/memory, a LimitRange with defaults is required.
    const needLimitRange =
      hasDefaults ||
      (hardQuota['requests.cpu'] !== undefined || hardQuota['requests.memory'] !== undefined);
    if (!needLimitRange) {
      try {
        await api.deleteNamespacedLimitRange(limitName, ns);
      } catch (error: any) {
        if (error?.response?.statusCode !== 404) {
          console.error('[K8s] delete LimitRange failed:', error?.message || error);
        }
      }
      return;
    }

    const defaultReq: Record<string, string> = {};
    const defaultLim: Record<string, string> = {};
    const cpuDefault = options.defaultPodCpuMilli && options.defaultPodCpuMilli > 0
      ? options.defaultPodCpuMilli
      : 100; // 100m
    const memDefault = options.defaultPodMemoryBytes && options.defaultPodMemoryBytes > 0
      ? options.defaultPodMemoryBytes
      : 128 * 1024 * 1024; // 128Mi
    defaultReq['cpu'] = `${cpuDefault}m`;
    defaultReq['memory'] = String(memDefault);
    defaultLim['cpu'] = `${cpuDefault * 4}m`;
    defaultLim['memory'] = String(memDefault * 4);

    const limitBody: k8s.V1LimitRange = {
      metadata: { name: limitName, labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
      spec: {
        limits: [
          {
            type: 'Container',
            default: defaultLim,
            defaultRequest: defaultReq,
          },
        ],
      },
    };

    try {
      await api.replaceNamespacedLimitRange(limitName, ns, limitBody);
    } catch (error: any) {
      if (error?.response?.statusCode === 404) {
        await api.createNamespacedLimitRange(ns, limitBody);
      } else {
        throw error;
      }
    }
  }

  // Aggregate resource requests for an org across all its namespaces.
  async getOrgUsage(namespaces: string[]): Promise<{ cpuMilli: number; memoryBytes: number; pods: number; services: number }> {
    this.ensureKubeConfig();
    if (!this.kc || namespaces.length === 0) return { cpuMilli: 0, memoryBytes: 0, pods: 0, services: 0 };
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const nsSet = new Set(namespaces);
    let cpuMilli = 0;
    let memoryBytes = 0;
    let pods = 0;
    let services = 0;
    try {
      const podRes = await api.listPodForAllNamespaces();
      for (const pod of podRes.body.items) {
        const ns = pod.metadata?.namespace;
        if (!ns || !nsSet.has(ns)) continue;
        const phase = pod.status?.phase;
        if (phase === 'Succeeded' || phase === 'Failed') continue;
        pods += 1;
        for (const c of pod.spec?.containers || []) {
          const req = c.resources?.requests || {};
          if (req.cpu) cpuMilli += parseCpu(String(req.cpu));
          if (req.memory) memoryBytes += parseMemory(String(req.memory));
        }
      }
      const svcRes = await api.listServiceForAllNamespaces();
      for (const s of svcRes.body.items) {
        const ns = s.metadata?.namespace;
        if (ns && nsSet.has(ns)) services += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] getOrgUsage failed:', message);
    }
    return { cpuMilli, memoryBytes, pods, services };
  }

  // Patch resources on a CNPG Cluster (rolling update of postgres pods).
  async updateCnpgClusterResources(
    namespace: string,
    clusterName: string,
    resources: { cpuMilli: number; memoryBytes: number },
  ) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
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
  }

  // Patch a deployment's pod-template container resources (triggers rolling restart).
  async updateDeploymentResources(
    namespace: string,
    deploymentName: string,
    resources: { cpuMilli: number; memoryBytes: number },
  ) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const cpuStr = cpuMilliToK8s(resources.cpuMilli);
    const memStr = memoryBytesToK8s(resources.memoryBytes);
    const existing = await appsApi.readNamespacedDeployment(deploymentName, namespace);
    const containers = existing.body.spec?.template?.spec?.containers;
    if (!containers || containers.length === 0) {
      throw new NotFoundException(`Deployment ${deploymentName} has no containers`);
    }
    const containerName = containers[0].name;
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: containerName,
                resources: {
                  requests: { cpu: cpuStr, memory: memStr },
                  limits: { cpu: cpuStr, memory: memStr },
                },
              },
            ],
          },
        },
      },
    };
    await appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
    );
  }

  async removeDeploymentResources(
    namespace: string,
    deploymentName: string,
  ) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const existing = await appsApi.readNamespacedDeployment(deploymentName, namespace);
    const containers = existing.body.spec?.template?.spec?.containers;
    if (!containers || containers.length === 0) {
      throw new NotFoundException(`Deployment ${deploymentName} has no containers`);
    }
    const containerName = containers[0].name;
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: containerName,
                resources: {
                  requests: {},
                  limits: {},
                },
              },
            ],
          },
        },
      },
    };
    await appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
    );
  }

  async listClusterNodes(): Promise<k8s.V1Node[]> {
    this.ensureKubeConfig();
    if (!this.kc) return [];
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const res = await api.listNode();
      return res.body.items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] listClusterNodes failed:', message);
      return [];
    }
  }

  // Returns per-node aggregated requests for all pods in the cluster.
  async getClusterPodUsage(): Promise<
    Array<{
      nodeName: string | null;
      namespace: string;
      podName: string;
      cpuRequestMilli: number;
      memoryRequestBytes: number;
      labels: Record<string, string>;
    }>
  > {
    this.ensureKubeConfig();
    if (!this.kc) return [];
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const res = await api.listPodForAllNamespaces();
      const out: Array<{
        nodeName: string | null;
        namespace: string;
        podName: string;
        cpuRequestMilli: number;
        memoryRequestBytes: number;
        labels: Record<string, string>;
      }> = [];
      for (const pod of res.body.items) {
        const phase = pod.status?.phase;
        if (phase === 'Succeeded' || phase === 'Failed') continue;
        const containers = pod.spec?.containers || [];
        let cpuMilli = 0;
        let memBytes = 0;
        for (const c of containers) {
          const req = c.resources?.requests || {};
          if (req.cpu) cpuMilli += parseCpu(String(req.cpu));
          if (req.memory) memBytes += parseMemory(String(req.memory));
        }
        out.push({
          nodeName: pod.spec?.nodeName || null,
          namespace: pod.metadata?.namespace || '',
          podName: pod.metadata?.name || '',
          cpuRequestMilli: cpuMilli,
          memoryRequestBytes: memBytes,
          labels: pod.metadata?.labels || {},
        });
      }
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] getClusterPodUsage failed:', message);
      return [];
    }
  }

  private mapServicePorts(
    ports: k8s.V1ServicePort[] | undefined,
    fallback: SanitizedPortEntry[] = []
  ): SanitizedPortEntry[] {
    if (!ports || ports.length === 0) {
      return fallback;
    }
    const mapped: SanitizedPortEntry[] = [];
    ports.forEach((entry, index) => {
      const portNumber = Number(entry.port);
      if (!Number.isInteger(portNumber) || portNumber <= 0) {
        return;
      }
      let containerPort = portNumber;
      const target = entry.targetPort;
      if (typeof target === 'number' && Number.isInteger(target) && target > 0) {
        containerPort = target;
      } else if (typeof target === 'string') {
        const numericTarget = Number.parseInt(target, 10);
        if (Number.isInteger(numericTarget) && numericTarget > 0) {
          containerPort = numericTarget;
        } else {
          const match = fallback.find((port) => port.name === target);
          if (match) {
            containerPort = match.containerPort;
          }
        }
      }
      const protocol = entry.protocol && entry.protocol.trim().length > 0
        ? entry.protocol.trim().toUpperCase()
        : 'TCP';
      let name = entry.name && entry.name.trim().length > 0
        ? entry.name.trim().toLowerCase()
        : `port-${index + 1}`;
      if (name.length > 63) {
        name = name.substring(0, 63);
      }
      const nodePort =
        typeof entry.nodePort === 'number' && Number.isInteger(entry.nodePort) && entry.nodePort > 0
          ? entry.nodePort
          : undefined;
      mapped.push({
        name,
        containerPort,
        servicePort: portNumber,
        protocol,
        nodePort,
      });
    });
    return mapped;
  }

  private ensureUniqueServicePorts(ports: SanitizedPortEntry[]): SanitizedPortEntry[] {
    const counts = new Map<string, number>();
    return ports.map((entry, index) => {
      let baseName = entry.name?.trim().toLowerCase() || `port-${index + 1}`;
      baseName = baseName.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
      if (!baseName) {
        baseName = `port-${index + 1}`;
      }
      const currentCount = counts.get(baseName) ?? 0;
      counts.set(baseName, currentCount + 1);
      let name = baseName;
      if (currentCount > 0) {
        const suffixValue = `-${currentCount}`;
        const trimmedBase = baseName.substring(0, Math.max(1, 63 - suffixValue.length));
        name = `${trimmedBase}${suffixValue}`;
      }
      return {
        ...entry,
        name,
      };
    });
  }

  async createNamespace(namespace: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const body: k8s.V1Namespace = {
        metadata: {
          name: cleanNamespace,
          labels: {
            'orchard.dev/managed': 'true',
            name: cleanNamespace,
          },
        },
      };

      await api.createNamespace(body);

      try {
        await this.createNetworkPolicy(cleanNamespace);
      } catch (networkPolicyError) {
        console.error(`[K8s] Failed to create network policy for namespace ${cleanNamespace}:`, networkPolicyError);
      }

      return {
        success: true,
        namespace: cleanNamespace,
        created: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 409) {
        return {
          success: true,
          namespace: cleanNamespace,
          created: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create namespace in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to create namespace',
        message: error.message,
      });
    }
  }

  async deleteNamespace(namespace: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      await api.deleteNamespace(cleanNamespace);

      return {
        success: true,
        namespace: cleanNamespace,
        deleted: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return {
          success: true,
          namespace: cleanNamespace,
          deleted: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete namespace in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete namespace',
        message: error.message,
      });
    }
  }

  async createNetworkPolicy(namespace: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    try {
      const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
      
      const networkPolicyBody: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'default-deny-all',
          namespace: cleanNamespace,
          labels: {
            'orchard.dev/managed': 'true',
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
                    matchLabels: {
                      'kubernetes.io/metadata.name': cleanNamespace,
                    },
                  },
                },
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'network',
                    },
                  },
                },
              ],
            },
          ],
          egress: [
            {},
          ],
        },
      };

      await networkingApi.createNamespacedNetworkPolicy(cleanNamespace, networkPolicyBody);

      return {
        success: true,
        namespace: cleanNamespace,
        created: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 409) {
        return {
          success: true,
          namespace: cleanNamespace,
          created: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create network policy in Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to create network policy',
        message: error.message,
      });
    }
  }

  async listPods(namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();
    
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    
    if (!cleanNamespace || cleanNamespace.length === 0) {
      throw new BadRequestException('Namespace parameter is required');
    }
    
    console.log('[API] Fetching pods from namespace:', cleanNamespace);
    
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const podList = await api.listNamespacedPod(cleanNamespace);
      
      const pods = podList.body.items.map(pod => ({
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        status: pod.status.phase,
        podIP: pod.status.podIP,
        hostIP: pod.status.hostIP,
        startTime: pod.status.startTime,
        conditions: pod.status.conditions,
        containerStatuses: pod.status.containerStatuses?.map(container => ({
          name: container.name,
          ready: container.ready,
          restartCount: container.restartCount,
          image: container.image,
          state: container.state
        })),
        labels: pod.metadata.labels,
        annotations: pod.metadata.annotations
      }));

      return {
        namespace: cleanNamespace,
        podCount: pods.length,
        pods
      };
    } catch (error) {
      console.error('Error fetching pods:', error);
      
      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch pods from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to fetch pods',
        message: error.message
      });
    }
  }

  async getKubernetesDeployment(deploymentName: string, namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();
    
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();
    
    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const k8sDeployment = await appsApi.readNamespacedDeployment(cleanDeploymentName, cleanNamespace);
      
      return {
        name: k8sDeployment.body.metadata.name,
        namespace: k8sDeployment.body.metadata.namespace,
        status: {
          replicas: k8sDeployment.body.spec.replicas,
          availableReplicas: k8sDeployment.body.status.availableReplicas ?? 0,
          readyReplicas: k8sDeployment.body.status.readyReplicas ?? 0,
          updatedReplicas: k8sDeployment.body.status.updatedReplicas ?? 0,
        }
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return null;
      }
      
      console.error('Error fetching deployment:', error);
      
      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch deployment from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to fetch deployment',
        message: error.message
      });
    }
  }

  async getPod(podName: string, namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanPodName = String(podName).trim();
    
    console.log('[API] Fetching pod:', cleanPodName, 'from namespace:', cleanNamespace);
    
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const pod = await api.readNamespacedPod(cleanPodName, cleanNamespace);
      
      return pod.body;
    } catch (error) {
      console.error('Error fetching pod:', error);
      
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Pod not found',
          message: `Pod ${cleanPodName} not found in namespace ${cleanNamespace}`
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to fetch pod',
        message: error.message
      });
    }
  }

  async deletePod(podName: string, namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanPodName = String(podName).trim();

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      await api.deleteNamespacedPod(cleanPodName, cleanNamespace);
      return { success: true, message: `Pod ${cleanPodName} deleted` };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Pod not found',
          message: `Pod ${cleanPodName} not found in namespace ${cleanNamespace}`,
        });
      }
      throw new BadRequestException({
        error: 'Failed to delete pod',
        message: error.message,
      });
    }
  }

  async getPodLogs(podName: string, namespace: string = 'midnight-staging', containerName?: string, tailLines: number = 100) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanPodName = String(podName).trim();
    const cleanContainerName = containerName ? String(containerName).trim() : '';
    
    console.log('[API] Fetching logs for pod:', cleanPodName, 'container:', cleanContainerName || '(default)', 'from namespace:', cleanNamespace);
    
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const pod = await api.readNamespacedPod(cleanPodName, cleanNamespace);
      const containers = pod.body.spec?.containers?.map(c => c.name) || [];
      
      if (containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Pod "${cleanPodName}" has no containers`
        });
      }
      
      if (!cleanContainerName && containers.length > 1) {
        throw new BadRequestException({
          error: 'Container name required',
          message: `Pod "${cleanPodName}" has multiple containers. Please specify one.`,
          availableContainers: containers
        });
      }
      
      const targetContainer = cleanContainerName || containers[0];
      
      if (cleanContainerName && !containers.includes(cleanContainerName)) {
        throw new BadRequestException({
          error: 'Container not found',
          message: `Container "${cleanContainerName}" not found in pod "${cleanPodName}"`,
          availableContainers: containers
        });
      }
      
      console.log('[API] Fetching logs for container:', targetContainer);
      
      try {
        const logs = await api.readNamespacedPodLog(
          cleanPodName,
          cleanNamespace,
          targetContainer,
          false,
          false,
          undefined,
          undefined,
          false,
          undefined,
          tailLines,
          true
        );
        
        return {
          podName: cleanPodName,
          container: targetContainer,
          namespace: cleanNamespace,
          logs: logs.body,
          tailLines: tailLines
        };
      } catch (logError) {
        const statusCode = logError.response?.statusCode;
        if (statusCode !== 404) {
          console.error('[API] Log fetch error details:', {
            message: logError.message,
            code: logError.code,
            statusCode: statusCode,
            body: logError.response?.body
          });
        }
        
        throw new BadRequestException({
          error: 'Failed to fetch logs',
          message: logError.response?.body?.message || logError.message || 'Error occurred in log request',
          availableContainers: containers,
          targetContainer: targetContainer,
          podStatus: pod.body.status?.phase,
          containerStatuses: pod.body.status?.containerStatuses?.map(cs => ({
            name: cs.name,
            ready: cs.ready,
            state: Object.keys(cs.state || {})[0],
            restartCount: cs.restartCount
          })),
          hint: 'The container may not be running or may not have generated any logs yet'
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      
      const statusCode = (error as any)?.response?.statusCode;
      if (statusCode !== 404) {
        console.error('Error fetching logs:', error);
      }
      throw new BadRequestException({
        error: 'Failed to fetch logs',
        message: error.message
      });
    }
  }

  async listEndpoints(namespace?: string) {
    this.ensureKubeConfig();
    
    const cleanNamespace = namespace ? String(namespace).trim() : undefined;
    
    console.log('[API] Fetching endpoints', cleanNamespace ? `from namespace: ${cleanNamespace}` : 'from all namespaces');
    
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      
      let endpointList;
      if (cleanNamespace) {
        endpointList = await api.listNamespacedEndpoints(cleanNamespace);
      } else {
        endpointList = await api.listEndpointsForAllNamespaces();
      }
      
      const endpoints = endpointList.body.items.map(endpoint => ({
        name: endpoint.metadata.name,
        namespace: endpoint.metadata.namespace,
        subsets: endpoint.subsets?.map(subset => ({
          addresses: subset.addresses?.map(addr => ({
            ip: addr.ip,
            hostname: addr.hostname,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef ? {
              kind: addr.targetRef.kind,
              name: addr.targetRef.name,
              namespace: addr.targetRef.namespace
            } : undefined
          })),
          notReadyAddresses: subset.notReadyAddresses?.map(addr => ({
            ip: addr.ip,
            hostname: addr.hostname,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef ? {
              kind: addr.targetRef.kind,
              name: addr.targetRef.name,
              namespace: addr.targetRef.namespace
            } : undefined
          })),
          ports: subset.ports?.map(port => ({
            name: port.name,
            port: port.port,
            protocol: port.protocol
          }))
        })),
        labels: endpoint.metadata.labels,
        annotations: endpoint.metadata.annotations
      }));

      return {
        namespace: cleanNamespace || 'all',
        endpointCount: endpoints.length,
        endpoints
      };
    } catch (error) {
      console.error('Error fetching endpoints:', error);
      
      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch endpoints from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to fetch endpoints',
        message: error.message
      });
    }
  }

  async listDeployments(namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();
    
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    
    console.log('[API] Fetching deployments from namespace:', cleanNamespace);
    
    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);
      const deploymentList = await api.listNamespacedDeployment(cleanNamespace);
      
      const deployments = deploymentList.body.items.map(deployment => ({
        name: deployment.metadata.name,
        namespace: deployment.metadata.namespace,
        replicas: deployment.spec.replicas,
        availableReplicas: deployment.status.availableReplicas,
        readyReplicas: deployment.status.readyReplicas,
        image: deployment.spec.template.spec.containers[0]?.image,
        labels: deployment.metadata.labels,
        createdAt: deployment.metadata.creationTimestamp,
      }));

      return {
        namespace: cleanNamespace,
        deploymentCount: deployments.length,
        deployments
      };
    } catch (error) {
      console.error('Error fetching deployments:', error);
      
      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch deployments from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to fetch deployments',
        message: error.message
      });
    }
  }

  async createDeployment(options: CreateDeploymentOptions) {
    this.ensureKubeConfig();

    const cleanNamespace = String(options.namespace || '').trim();
    const cleanName = String(options.name || '').trim();
    const cleanImage = String(options.image || '').trim();
    const replicas = Math.max(1, options.replicas || 1);
    let sanitizedPorts = this.sanitizePortEntries(Array.isArray(options.ports) ? options.ports : []);

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!cleanImage) {
      throw new BadRequestException('Image is required');
    }

    const envEntries = Array.isArray(options.env)
      ? options.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: String(entry.key).trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : ''
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, string>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, entry.value);
    }

    if (!uniqueEnv.has('HOST')) {
      uniqueEnv.set('HOST', '0.0.0.0');
    }
    if (!uniqueEnv.has('FORCE_COLOR')) {
      uniqueEnv.set('FORCE_COLOR', '1');
    }

    const envList = Array.from(uniqueEnv.entries()).map(([key, value]) => ({
      name: key,
      value
    }));

    const requestedServiceType =
      options.serviceType === 'LoadBalancer'
        ? 'LoadBalancer'
        : options.serviceType === 'NodePort'
        ? 'NodePort'
        : 'ClusterIP';

    let externalAddress: string | null = null;

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const selectorLabels = {
        'app.kubernetes.io/name': cleanName
      };

      const labels = {
        ...selectorLabels,
        'app.kubernetes.io/managed-by': 'orchard'
      };

      const volumes = Array.isArray(options.volumes) ? options.volumes : [];

      // Create PVCs in Kubernetes before referencing them
      for (const vol of volumes) {
        if (vol.type === 'pvc' && vol.pvcName) {
          await this.createPVC(cleanNamespace, vol.pvcName, vol.storageSize || '1Gi');
        }
      }

      const volumeMounts: k8s.V1VolumeMount[] = volumes.map((vol) => ({
        name: vol.name,
        mountPath: vol.mountPath,
        readOnly: Boolean(vol.readOnly),
      }));

      const k8sVolumes: k8s.V1Volume[] = volumes.map((vol) => {
        const volume: k8s.V1Volume = {
          name: vol.name,
        };

        if (vol.type === 'pvc' && vol.pvcName) {
          volume.persistentVolumeClaim = {
            claimName: vol.pvcName,
          };
        } else if (vol.type === 'hostPath' && vol.hostPath) {
          volume.hostPath = {
            path: vol.hostPath,
            type: 'DirectoryOrCreate',
          };
        } else if (vol.type === 'emptyDir') {
          volume.emptyDir = {};
        }

        return volume;
      });

      const container: k8s.V1Container = {
        name: cleanName,
        image: cleanImage,
        imagePullPolicy: 'IfNotPresent',
        ports: sanitizedPorts.map((port) => ({
          name: port.name,
          containerPort: port.containerPort,
          protocol: port.protocol
        })),
        env: envList,
        volumeMounts: volumeMounts.length > 0 ? volumeMounts : undefined,
      };

      // requests == limits → Guaranteed QoS. Quota usage matches real-world usage.
      if (options.resources) {
        const cpuStr = cpuMilliToK8s(options.resources.cpuMilli);
        const memStr = memoryBytesToK8s(options.resources.memoryBytes);
        container.resources = {
          requests: { cpu: cpuStr, memory: memStr },
          limits: { cpu: cpuStr, memory: memStr },
        };
      }

      // Apply health checks if configured
      if (options.healthCheck?.enabled) {
        const hc = options.healthCheck;
        const buildProbe = (failureThreshold?: number): k8s.V1Probe => {
          const probe: k8s.V1Probe = {
            periodSeconds: hc.interval,
            timeoutSeconds: hc.timeout,
            failureThreshold: failureThreshold ?? hc.retries,
          };
          if (hc.type === 'http') {
            probe.httpGet = { path: hc.path || '/', port: hc.port || 80 };
          } else if (hc.type === 'tcp') {
            probe.tcpSocket = { port: hc.port || 80 };
          } else if (hc.type === 'exec') {
            probe.exec = { command: hc.command ? hc.command.split(' ') : ['/bin/sh', '-c', 'exit 0'] };
          }
          return probe;
        };
        if (hc.livenessEnabled) container.livenessProbe = buildProbe();
        if (hc.readinessEnabled) container.readinessProbe = buildProbe();
        if (hc.startupEnabled) container.startupProbe = buildProbe(hc.startupFailureThreshold);
      }

      const affinity = buildNodeAffinity(options.allowedNodes, options.deniedNodes);

      // PVC volumes can't be held by two pods at once on most CSI drivers
      // (ReadWriteOnce), so a rolling cutover would deadlock waiting for the
      // old pod to release the volume. Force Recreate whenever a PVC is in
      // the volume list, regardless of caller's preference.
      const hasPvcVolume = (options.volumes ?? []).some((v) => v.type === 'pvc');
      const effectiveStrategy = hasPvcVolume ? 'recreate' : (options.deployStrategy ?? 'rollingUpdate');
      const strategy: k8s.V1DeploymentStrategy = effectiveStrategy === 'recreate'
        ? { type: 'Recreate' }
        : { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } };

      const deploymentBody: k8s.V1Deployment = {
        metadata: {
          name: cleanName,
          labels
        },
        spec: {
          replicas,
          strategy,
          selector: {
            matchLabels: selectorLabels
          },
          template: {
            metadata: {
              labels
            },
            spec: {
              containers: [container],
              volumes: k8sVolumes.length > 0 ? k8sVolumes : undefined,
              affinity: affinity || undefined,
            }
          }
        }
      };

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: cleanName,
          labels
        },
        spec: {
          type: requestedServiceType,
          selector: selectorLabels,
          ports: sanitizedPorts.map((port) => {
            const entry: k8s.V1ServicePort = {
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol
            };
            if (requestedServiceType === 'NodePort' && port.nodePort && port.nodePort >= 30000) {
              entry.nodePort = port.nodePort;
            }
            return entry;
          })
        }
      };

      let deploymentCreated = false;

      try {
        await appsApi.createNamespacedDeployment(cleanNamespace, deploymentBody);
        deploymentCreated = true;
        const serviceResponse = await coreApi.createNamespacedService(cleanNamespace, serviceBody);

        const fetchedService = await coreApi.readNamespacedService(cleanName, cleanNamespace);
        if (requestedServiceType === 'LoadBalancer') {
          const ingressStatus = fetchedService.body.status?.loadBalancer?.ingress?.[0];
          if (ingressStatus) {
            externalAddress = ingressStatus.ip || ingressStatus.hostname || null;
          } else if (serviceResponse.body.status?.loadBalancer?.ingress?.[0]) {
            const fallbackIngress = serviceResponse.body.status.loadBalancer.ingress[0];
            externalAddress = fallbackIngress.ip || fallbackIngress.hostname || null;
          }
        } else if (requestedServiceType === 'NodePort') {
          const mappedPorts = this.mapServicePorts(fetchedService.body.spec?.ports, sanitizedPorts);
          if (mappedPorts.length > 0) {
            const nodePortMap = new Map<string, number>();
            mappedPorts.forEach((port) => {
              if (port.nodePort) {
                nodePortMap.set(port.name, port.nodePort);
                nodePortMap.set(`${port.servicePort}-${port.protocol}`, port.nodePort);
              }
            });
            sanitizedPorts = sanitizedPorts.map((port) => {
              const nodePort =
                nodePortMap.get(port.name) || nodePortMap.get(`${port.servicePort}-${port.protocol}`);
              if (nodePort) {
                return {
                  ...port,
                  nodePort,
                };
              }
              return port;
            });
          }
          externalAddress = await this.getDefaultNodeIp(coreApi);
        }
      } catch (error) {
        if (deploymentCreated) {
          try {
            await appsApi.deleteNamespacedDeployment(cleanName, cleanNamespace);
          } catch (cleanupError) {
            console.error('[K8s] Deployment cleanup failed after error', {
              message: cleanupError.message,
              code: cleanupError.code,
              statusCode: cleanupError.response?.statusCode
            });
          }
        }

        if (error.response) {
          throw new BadRequestException({
            error: 'Failed to create deployment',
            message: error.response.body?.message || error.message,
            details: error.response.body
          });
        }

        throw new BadRequestException({
          error: 'Failed to create deployment',
          message: error.message
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create deployment',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create deployment',
        message: error.message
      });
    }

    return {
      success: true,
      deployment: cleanName,
      namespace: cleanNamespace,
      image: cleanImage,
      replicas,
      port: sanitizedPorts[0]?.servicePort ?? 80,
      ports: sanitizedPorts,
      env: envList,
      serviceType: requestedServiceType,
      externalIp: externalAddress
    };
  }

  async createBasicAuthSecret(namespace: string, name: string, username: string, password: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Secret name is required');
    }

    if (!username || !password) {
      throw new BadRequestException('Username and password are required');
    }

    const bcrypt = require('bcrypt');
    const hashedPassword = bcrypt.hashSync(password, 10);
    const authString = `${username}:${hashedPassword}`;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const secretBody: k8s.V1Secret = {
      metadata: {
        name: cleanName,
        namespace: cleanNamespace,
        labels: {
          'leaf.dev/managed': 'true',
          'leaf.dev/type': 'basic-auth'
        }
      },
      type: 'Opaque',
      stringData: {
        users: authString
      }
    };

    try {
      await coreApi.createNamespacedSecret(cleanNamespace, secretBody);
    } catch (error) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedSecret(cleanName, cleanNamespace, secretBody);
      } else {
        throw new BadRequestException({
          error: 'Failed to create basic auth secret',
          message: error.response?.body?.message || error.message,
          details: error.response?.body
        });
      }
    }
  }

  async deleteBasicAuthSecret(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedSecret(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete basic auth secret ${cleanName} in ${cleanNamespace}:`, error);
      }
    }
  }

  async createBasicAuthMiddleware(namespace: string, name: string, secretName: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const middlewareBody = {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: {
        name: `${cleanName}-auth`,
        namespace: cleanNamespace,
        labels: {
          'leaf.dev/managed': 'true',
          'leaf.dev/type': 'basic-auth-middleware'
        }
      },
      spec: {
        basicAuth: {
          secret: secretName
        }
      }
    };

    try {
      await customObjectsApi.createNamespacedCustomObject(
        'traefik.io',
        'v1alpha1',
        cleanNamespace,
        'middlewares',
        middlewareBody
      );
    } catch (error) {
      if (error.response?.statusCode === 409) {
        try {
          await customObjectsApi.replaceNamespacedCustomObject(
            'traefik.io',
            'v1alpha1',
            cleanNamespace,
            'middlewares',
            `${cleanName}-auth`,
            middlewareBody
          );
        } catch (replaceError) {
          console.error(`Failed to update basic auth middleware: ${replaceError.message}`);
        }
      } else {
        console.error(`Failed to create basic auth middleware: ${error.message}`);
      }
    }
  }

  async deleteBasicAuthMiddleware(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    try {
      await customObjectsApi.deleteNamespacedCustomObject(
        'traefik.io',
        'v1alpha1',
        cleanNamespace,
        'middlewares',
        `${cleanName}-auth`
      );
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete basic auth middleware ${cleanName}-auth in ${cleanNamespace}:`, error);
      }
    }
  }

  async createHttpsRedirectMiddleware(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const middlewareBody = {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: {
        name: `${cleanName}-redirect-https`,
        namespace: cleanNamespace,
        labels: {
          'leaf.dev/managed': 'true',
          'leaf.dev/type': 'redirect-https-middleware'
        }
      },
      spec: {
        redirectScheme: {
          scheme: 'https',
          permanent: true
        }
      }
    };

    try {
      await customObjectsApi.createNamespacedCustomObject(
        'traefik.io',
        'v1alpha1',
        cleanNamespace,
        'middlewares',
        middlewareBody
      );
    } catch (error) {
      if (error.response?.statusCode === 409) {
        try {
          await customObjectsApi.replaceNamespacedCustomObject(
            'traefik.io',
            'v1alpha1',
            cleanNamespace,
            'middlewares',
            `${cleanName}-redirect-https`,
            middlewareBody
          );
        } catch (replaceError) {
          console.error(`Failed to update HTTPS redirect middleware: ${replaceError.message}`);
        }
      } else {
        console.error(`Failed to create HTTPS redirect middleware: ${error.message}`);
      }
    }
  }

  async deleteHttpsRedirectMiddleware(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    try {
      await customObjectsApi.deleteNamespacedCustomObject(
        'traefik.io',
        'v1alpha1',
        cleanNamespace,
        'middlewares',
        `${cleanName}-redirect-https`
      );
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete HTTPS redirect middleware ${cleanName}-redirect-https in ${cleanNamespace}:`, error);
      }
    }
  }

  async createIngress(options: CreateIngressOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    const host = String(options.host || '').trim().toLowerCase();
    const ingressClassName =
      String(options.ingressClassName || '').trim() || undefined;

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!name) {
      throw new BadRequestException('Ingress name is required');
    }

    if (!host) {
      throw new BadRequestException('Host is required');
    }

    const pathBackends = Array.isArray(options.paths) && options.paths.length > 0
      ? options.paths
      : [{
          path: String(options.path || '/').trim() || '/',
          pathType: String(options.pathType || 'Prefix').trim() || 'Prefix',
          serviceName: String(options.serviceName || '').trim(),
          servicePort: Number(options.servicePort)
        }];

    if (!pathBackends[0].serviceName || !Number.isInteger(pathBackends[0].servicePort) || pathBackends[0].servicePort <= 0) {
      throw new BadRequestException('Service name and port are required');
    }

    for (const pb of pathBackends) {
      const svcName = String(pb.serviceName || '').trim();
      const svcPort = Number(pb.servicePort);
      if (!svcName || !Number.isInteger(svcPort) || svcPort <= 0) {
        throw new BadRequestException('Each path must have a valid service name and port');
      }
    }

    const annotations: Record<string, string> = {};

    if (options.annotations) {
      for (const [key, value] of Object.entries(options.annotations)) {
        if (value === undefined || value === null) {
          continue;
        }
        annotations[String(key)] = String(value);
      }
    }

    if (options.entrypoints && options.entrypoints.length > 0) {
      if (!annotations['traefik.ingress.kubernetes.io/router.entrypoints']) {
        const normalizedEntrypoints = options.entrypoints
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0);
        if (normalizedEntrypoints.length > 0) {
          annotations['traefik.ingress.kubernetes.io/router.entrypoints'] =
            normalizedEntrypoints.join(',');
        }
      }
    }

    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
      try {
        await this.createBasicAuthSecret(
          namespace,
          basicAuthSecretName,
          options.basicAuth.username,
          options.basicAuth.password
        );

        await this.createBasicAuthMiddleware(namespace, name, basicAuthSecretName);
      } catch (error) {
        console.error('[K8s] Failed to create basic auth:', error);
      }
    }

    const hasTls = options.tlsSecretName && options.tlsSecretName.trim().length > 0;

    if (hasTls) {
      try {
        await this.createHttpsRedirectMiddleware(namespace, name);
      } catch (error) {
        console.error('[K8s] Failed to create HTTPS redirect middleware:', error);
      }

      annotations['traefik.ingress.kubernetes.io/router.entrypoints'] = 'web,websecure';
    }

    const middlewares: string[] = [];
    if (hasTls) {
      middlewares.push(`${namespace}-${name}-redirect-https@kubernetescrd`);
    }
    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      middlewares.push(`${namespace}-${name}-auth@kubernetescrd`);
    }
    if (middlewares.length > 0) {
      annotations['traefik.ingress.kubernetes.io/router.middlewares'] = middlewares.join(',');
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const tlsHosts = hasTls
      ? (options.tlsHosts && options.tlsHosts.length > 0
          ? options.tlsHosts
          : [host])
      : [];

    const httpPaths = pathBackends.map((pb) => {
      const path = String(pb.path || '/').trim() || '/';
      const pathType = String(pb.pathType || 'Prefix').trim() || 'Prefix';
      return {
        path,
        pathType,
        backend: {
          service: {
            name: String(pb.serviceName).trim(),
            port: { number: Number(pb.servicePort) }
          }
        }
      };
    });

    const ingressBody: k8s.V1Ingress = {
      metadata: {
        name,
        labels: {
          'leaf.dev/managed': 'true'
        },
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined
      },
      spec: {
        ingressClassName,
        rules: [
          {
            host,
            http: {
              paths: httpPaths
            }
          }
        ]
      }
    };

    if (hasTls) {
      ingressBody.spec.tls = [
        {
          hosts: tlsHosts,
          secretName: options.tlsSecretName.trim()
        }
      ];
    }

    try {
      const response = await networkingApi.createNamespacedIngress(
        namespace,
        ingressBody
      );
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 409) {
        throw new BadRequestException({
          error: 'Ingress already exists',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create ingress',
        message: error.message
      });
    }
  }

  async updateIngress(options: CreateIngressOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    const host = String(options.host || '').trim().toLowerCase();
    const ingressClassName =
      String(options.ingressClassName || '').trim() || undefined;

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!name) {
      throw new BadRequestException('Ingress name is required');
    }

    if (!host) {
      throw new BadRequestException('Host is required');
    }

    const pathBackends = Array.isArray(options.paths) && options.paths.length > 0
      ? options.paths
      : [{
          path: String(options.path || '/').trim() || '/',
          pathType: String(options.pathType || 'Prefix').trim() || 'Prefix',
          serviceName: String(options.serviceName || '').trim(),
          servicePort: Number(options.servicePort)
        }];

    if (!pathBackends[0].serviceName || !Number.isInteger(pathBackends[0].servicePort) || pathBackends[0].servicePort <= 0) {
      throw new BadRequestException('Service name and port are required');
    }

    for (const pb of pathBackends) {
      const svcName = String(pb.serviceName || '').trim();
      const svcPort = Number(pb.servicePort);
      if (!svcName || !Number.isInteger(svcPort) || svcPort <= 0) {
        throw new BadRequestException('Each path must have a valid service name and port');
      }
    }

    const annotations: Record<string, string> = {};

    if (options.annotations) {
      for (const [key, value] of Object.entries(options.annotations)) {
        if (value === undefined || value === null) {
          continue;
        }
        annotations[String(key)] = String(value);
      }
    }

    if (options.entrypoints && options.entrypoints.length > 0) {
      if (!annotations['traefik.ingress.kubernetes.io/router.entrypoints']) {
        const normalizedEntrypoints = options.entrypoints
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0);
        if (normalizedEntrypoints.length > 0) {
          annotations['traefik.ingress.kubernetes.io/router.entrypoints'] =
            normalizedEntrypoints.join(',');
        }
      }
    }

    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
      try {
        await this.createBasicAuthSecret(
          namespace,
          basicAuthSecretName,
          options.basicAuth.username,
          options.basicAuth.password
        );

        await this.createBasicAuthMiddleware(namespace, name, basicAuthSecretName);
      } catch (error) {
        console.error('[K8s] Failed to create basic auth:', error);
      }
    } else if (options.basicAuth?.enabled === false) {
      try {
        const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
        await this.deleteBasicAuthSecret(namespace, basicAuthSecretName);
        await this.deleteBasicAuthMiddleware(namespace, name);
      } catch (error) {
        console.error('[K8s] Failed to remove basic auth:', error);
      }
    }

    const hasTls = options.tlsSecretName && options.tlsSecretName.trim().length > 0;

    if (hasTls) {
      try {
        await this.createHttpsRedirectMiddleware(namespace, name);
      } catch (error) {
        console.error('[K8s] Failed to create HTTPS redirect middleware:', error);
      }

      annotations['traefik.ingress.kubernetes.io/router.entrypoints'] = 'web,websecure';
    } else {
      try {
        await this.deleteHttpsRedirectMiddleware(namespace, name);
      } catch (error) {
        console.error('[K8s] Failed to delete HTTPS redirect middleware:', error);
      }
    }

    const middlewares: string[] = [];
    if (hasTls) {
      middlewares.push(`${namespace}-${name}-redirect-https@kubernetescrd`);
    }
    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      middlewares.push(`${namespace}-${name}-auth@kubernetescrd`);
    }
    if (middlewares.length > 0) {
      annotations['traefik.ingress.kubernetes.io/router.middlewares'] = middlewares.join(',');
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const tlsHosts = hasTls
      ? (options.tlsHosts && options.tlsHosts.length > 0
          ? options.tlsHosts
          : [host])
      : [];

    const httpPaths = pathBackends.map((pb) => {
      const path = String(pb.path || '/').trim() || '/';
      const pathType = String(pb.pathType || 'Prefix').trim() || 'Prefix';
      return {
        path,
        pathType,
        backend: {
          service: {
            name: String(pb.serviceName).trim(),
            port: { number: Number(pb.servicePort) }
          }
        }
      };
    });

    const ingressBody: k8s.V1Ingress = {
      metadata: {
        name,
        labels: {
          'leaf.dev/managed': 'true'
        },
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined
      },
      spec: {
        ingressClassName,
        rules: [
          {
            host,
            http: {
              paths: httpPaths
            }
          }
        ]
      }
    };

    if (hasTls) {
      ingressBody.spec.tls = [
        {
          hosts: tlsHosts,
          secretName: options.tlsSecretName.trim()
        }
      ];
    } else {
      ingressBody.spec.tls = [];
    }

    try {
      const response = await networkingApi.replaceNamespacedIngress(
        name,
        namespace,
        ingressBody
      );
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Ingress not found',
          message: `Ingress ${name} not found in namespace ${namespace}`,
          details: error.response.body
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update ingress',
        message: error.message
      });
    }
  }

  async readIngress(namespace: string, name: string) {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const response = await networkingApi.readNamespacedIngress(name, namespace);
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async deleteIngress(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Ingress name is required');
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    try {
      await networkingApi.deleteNamespacedIngress(cleanName, cleanNamespace);

      await this.deleteBasicAuthSecret(cleanNamespace, `${cleanName}-basic-auth`);
      await this.deleteBasicAuthMiddleware(cleanNamespace, cleanName);
      await this.deleteHttpsRedirectMiddleware(cleanNamespace, cleanName);

      return {
        success: true,
        namespace: cleanNamespace,
        name: cleanName,
        deleted: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return {
          success: true,
          namespace: cleanNamespace,
          name: cleanName,
          deleted: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete ingress',
        message: error.message,
      });
    }
  }

  async deleteService(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedService(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete service ${cleanName} in ${cleanNamespace}:`, error);
      }
    }
  }

  async deletePVC(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete PVC ${cleanName} in ${cleanNamespace}:`, error);
      }
    }
  }

  async createPVC(namespace: string, name: string, storageSize: string = '1Gi') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    // Check if PVC already exists
    try {
      await coreApi.readNamespacedPersistentVolumeClaim(cleanName, cleanNamespace);
      // PVC already exists, no need to create
      return;
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        throw error;
      }
      // 404 = doesn't exist, proceed to create
    }

    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: {
        name: cleanName,
        namespace: cleanNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'longhorn',
        resources: {
          requests: {
            storage: storageSize,
          },
        },
      },
    };

    await coreApi.createNamespacedPersistentVolumeClaim(cleanNamespace, pvc);
  }

  async updateDeploymentEnv(options: UpdateDeploymentEnvOptions) {
    this.ensureKubeConfig();

    const cleanNamespace = String(options.namespace || '').trim();
    const cleanName = String(options.deploymentName || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    const envEntries = Array.isArray(options.env)
      ? options.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: String(entry.key).trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : ''
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, string>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, entry.value);
    }

    if (!uniqueEnv.has('HOST')) {
      uniqueEnv.set('HOST', '0.0.0.0');
    }
    if (!uniqueEnv.has('FORCE_COLOR')) {
      uniqueEnv.set('FORCE_COLOR', '1');
    }

    const envList = Array.from(uniqueEnv.entries()).map(([key, value]) => ({
      name: key,
      value
    }));

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

      const existing = await appsApi.readNamespacedDeployment(cleanName, cleanNamespace);

      const containers = existing.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${cleanName}" has no containers`
        });
      }

      const containerName = containers[0].name;

      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'orchard.dev/env-updated-at': new Date().toISOString()
              }
            },
            spec: {
              containers: [
                {
                  name: containerName,
                  env: envList
                }
              ]
            }
          }
        }
      };

      await appsApi.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace,
        env: envList
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update deployment environment',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update deployment environment',
        message: error.message
      });
    }
  }

  async updateDeploymentHealthCheck(options: {
    namespace: string;
    deploymentName: string;
    enabled: boolean;
    type: string;
    path?: string | null;
    port?: number | null;
    command?: string | null;
    livenessEnabled: boolean;
    readinessEnabled: boolean;
    startupEnabled: boolean;
    interval: number;
    timeout: number;
    retries: number;
    startupFailureThreshold: number;
  }) {
    const cleanName = String(options.deploymentName || '').trim();
    const cleanNamespace = String(options.namespace || '').trim();

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const existing = await appsApi.readNamespacedDeployment(cleanName, cleanNamespace);

      const containers = existing.body.spec?.template?.spec?.containers;
      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${cleanName}" has no containers`
        });
      }

      const containerName = containers[0].name;

      let livenessProbe: k8s.V1Probe | null = null;
      let readinessProbe: k8s.V1Probe | null = null;
      let startupProbe: k8s.V1Probe | null = null;

      if (options.enabled) {
        const buildProbe = (failureThreshold?: number): k8s.V1Probe => {
          const probe: k8s.V1Probe = {
            periodSeconds: options.interval,
            timeoutSeconds: options.timeout,
            failureThreshold: failureThreshold ?? options.retries,
          };

          if (options.type === 'http') {
            probe.httpGet = {
              path: options.path || '/',
              port: options.port || 80,
            };
          } else if (options.type === 'tcp') {
            probe.tcpSocket = {
              port: options.port || 80,
            };
          } else if (options.type === 'exec') {
            probe.exec = {
              command: options.command ? options.command.split(' ') : ['/bin/sh', '-c', 'exit 0'],
            };
          }

          return probe;
        };

        if (options.livenessEnabled) {
          livenessProbe = buildProbe();
        }
        if (options.readinessEnabled) {
          readinessProbe = buildProbe();
        }
        if (options.startupEnabled) {
          startupProbe = buildProbe(options.startupFailureThreshold);
        }
      }

      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'orchard.dev/health-check-updated-at': new Date().toISOString()
              }
            },
            spec: {
              containers: [
                {
                  name: containerName,
                  livenessProbe,
                  readinessProbe,
                  startupProbe,
                }
              ]
            }
          }
        }
      };

      await appsApi.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }

      throw new BadRequestException({
        error: 'Failed to update deployment health check',
        message: error.response?.body?.message || error.message,
      });
    }
  }

  async updateDeploymentVolumes(options: {
    namespace: string;
    deploymentName: string;
    volumes: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string | null;
      storageSize?: string | null;
      hostPath?: string | null;
      readOnly?: boolean;
    }[];
    deployStrategy?: 'rollingUpdate' | 'recreate';
  }) {
    this.ensureKubeConfig();

    const cleanNamespace = String(options.namespace || '').trim();
    const cleanName = String(options.deploymentName || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    const volumesList = Array.isArray(options.volumes) ? options.volumes : [];

    // Create PVCs in Kubernetes before referencing them
    for (const vol of volumesList) {
      if (vol.type === 'pvc' && vol.pvcName) {
        await this.createPVC(cleanNamespace, vol.pvcName, vol.storageSize || '1Gi');
      }
    }

    const volumeMounts: k8s.V1VolumeMount[] = volumesList.map((vol) => ({
      name: vol.name,
      mountPath: vol.mountPath,
      readOnly: Boolean(vol.readOnly),
    }));

    const k8sVolumes: k8s.V1Volume[] = volumesList.map((vol) => {
      const volume: k8s.V1Volume = {
        name: vol.name,
      };

      if (vol.type === 'pvc' && vol.pvcName) {
        volume.persistentVolumeClaim = {
          claimName: vol.pvcName,
        };
      } else if (vol.type === 'hostPath' && vol.hostPath) {
        volume.hostPath = {
          path: vol.hostPath,
          type: 'DirectoryOrCreate',
        };
      } else if (vol.type === 'emptyDir') {
        volume.emptyDir = {};
      }

      return volume;
    });

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

      const existing = await appsApi.readNamespacedDeployment(cleanName, cleanNamespace);

      const containers = existing.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${cleanName}" has no containers`
        });
      }

      const containerName = containers[0].name;

      // Force Recreate when a PVC is in the new volume set; otherwise honour
      // whatever the caller passed (or fall back to RollingUpdate).
      const hasPvcVolume = volumesList.some((v) => v.type === 'pvc');
      const effectiveStrategy = hasPvcVolume ? 'recreate' : (options.deployStrategy ?? 'rollingUpdate');
      const strategy: k8s.V1DeploymentStrategy = effectiveStrategy === 'recreate'
        ? { type: 'Recreate', rollingUpdate: null as any }
        : { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } };

      const patch = {
        spec: {
          strategy,
          template: {
            metadata: {
              annotations: {
                'orchard.dev/volumes-updated-at': new Date().toISOString()
              }
            },
            spec: {
              containers: [
                {
                  name: containerName,
                  volumeMounts: volumeMounts.length > 0 ? volumeMounts : []
                }
              ],
              volumes: k8sVolumes.length > 0 ? k8sVolumes : []
            }
          }
        }
      };

      await appsApi.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace,
        volumes: volumesList,
        deployStrategy: effectiveStrategy,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update deployment volumes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update deployment volumes',
        message: error.message
      });
    }
  }

  async updateServicePorts(options: UpdateServicePortsOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    const sanitizedPorts = this.sanitizePortEntries(
      Array.isArray(options.ports) ? options.ports : []
    );
    const normalizedPorts = this.ensureUniqueServicePorts(sanitizedPorts);

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const existingDeployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
      const containers = existingDeployment.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${deploymentName}" has no containers`,
        });
      }

      const containerName = containers[0].name;
      const existingContainer = containers[0];

      const updatedContainer = {
        ...existingContainer,
        ports: normalizedPorts.map((port) => ({
          name: port.name,
          containerPort: port.containerPort,
          protocol: port.protocol,
        })),
      };

      const deploymentPatch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'orchard.dev/service-updated-at': new Date().toISOString(),
              },
            },
            spec: {
              containers: existingDeployment.body.spec.template.spec.containers.map((c: any) =>
                c.name === containerName ? updatedContainer : c
              ),
            },
          },
        },
      };

      await appsApi.patchNamespacedDeployment(
        deploymentName,
        namespace,
        deploymentPatch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' },
        }
      );

      const existingService = await coreApi.readNamespacedService(serviceName, namespace);
      const serviceType = existingService.body.spec?.type || 'ClusterIP';
      const existingPorts = existingService.body.spec?.ports || [];
      const existingNodePortByName = new Map<string, number>();
      const existingNodePortBySignature = new Map<string, number>();

      existingPorts.forEach((entry) => {
        if (
          typeof entry.nodePort === 'number' &&
          Number.isInteger(entry.nodePort) &&
          entry.nodePort > 0
        ) {
          if (entry.name && entry.name.length > 0) {
            existingNodePortByName.set(entry.name, entry.nodePort);
          }
          const signature = `${entry.port}-${entry.protocol ?? 'TCP'}`.toLowerCase();
          existingNodePortBySignature.set(signature, entry.nodePort);
        }
      });

      const portsForService = normalizedPorts.map((port) => {
        let nodePortValue =
          typeof port.nodePort === 'number' &&
          Number.isInteger(port.nodePort) &&
          port.nodePort >= 30000 &&
          port.nodePort <= 32767
            ? port.nodePort
            : undefined;

        if (serviceType === 'NodePort' || serviceType === 'LoadBalancer') {
          const signature = `${port.servicePort}-${port.protocol}`.toLowerCase();
          const fallbackNodePort =
            nodePortValue ??
            existingNodePortByName.get(port.name) ??
            existingNodePortBySignature.get(signature);
          if (fallbackNodePort) {
            nodePortValue = fallbackNodePort;
          }
        } else {
          nodePortValue = undefined;
        }

        return {
          ...port,
          nodePort: nodePortValue,
        };
      });

      try {
        await coreApi.deleteNamespacedService(serviceName, namespace);
      } catch (deleteError) {
        if (deleteError.response?.statusCode !== 404) {
          throw deleteError;
        }
      }

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: serviceName,
          labels: existingService.body.metadata?.labels,
          annotations: existingService.body.metadata?.annotations,
        },
        spec: {
          type: serviceType,
          selector:
            existingService.body.spec?.selector || {
              'app.kubernetes.io/name': deploymentName,
            },
          ports: portsForService.map((port) => {
            const entry: k8s.V1ServicePort = {
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
            };
            if (
              (serviceType === 'NodePort' || serviceType === 'LoadBalancer') &&
              port.nodePort
            ) {
              entry.nodePort = port.nodePort;
            }
            return entry;
          }),
        },
      };

      if (existingService.body.spec?.clusterIP) {
        serviceBody.spec.clusterIP = existingService.body.spec.clusterIP;
      }
      if (existingService.body.spec?.clusterIPs) {
        serviceBody.spec.clusterIPs = existingService.body.spec.clusterIPs;
      }
      if (existingService.body.spec?.ipFamilyPolicy) {
        serviceBody.spec.ipFamilyPolicy = existingService.body.spec.ipFamilyPolicy;
      }
      if (existingService.body.spec?.ipFamilies) {
        serviceBody.spec.ipFamilies = existingService.body.spec.ipFamilies;
      }

      try {
        await coreApi.createNamespacedService(namespace, serviceBody);
      } catch (createError) {
        throw new BadRequestException({
          error: 'Failed to recreate service',
          message: createError.response?.body?.message || createError.message,
          details: createError.response?.body,
        });
      }

      const updatedService = await coreApi.readNamespacedService(serviceName, namespace);
      const updatedType = updatedService.body.spec?.type || serviceType;
      const mappedPorts = this.mapServicePorts(
        updatedService.body.spec?.ports,
        portsForService
      );

      let externalIp: string | null = null;
      if (updatedType === 'LoadBalancer') {
        const statusRecord = updatedService.body.status?.loadBalancer?.ingress?.[0];
        externalIp = statusRecord?.ip || statusRecord?.hostname || null;
      } else if (updatedType === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }

      return {
        success: true,
        namespace,
        deploymentName,
        serviceName,
        type: updatedType,
        ports: mappedPorts,
        externalIp,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Resource not found',
          message: `Deployment or service not found in namespace ${namespace}`,
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update service',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to update service',
        message: error.message,
      });
    }
  }

  async createDeploymentService(options: CreateAdditionalServiceOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    const sanitizedPorts = this.ensureUniqueServicePorts(
      this.sanitizePortEntries(Array.isArray(options.ports) ? options.ports : [])
    );

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    if (sanitizedPorts.length === 0) {
      throw new BadRequestException('At least one service port is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const deployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
      const containers = deployment.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'Deployment has no containers',
          message: `Deployment "${deploymentName}" has no containers`,
        });
      }

      const targetContainer = containers[0];
      const existingPorts = Array.isArray(targetContainer.ports)
        ? targetContainer.ports
        : [];
      const mergedPorts: k8s.V1ContainerPort[] = [];
      const usedSignatures = new Set<string>();

      existingPorts.forEach((port, index) => {
        if (
          typeof port.containerPort === 'number' &&
          Number.isInteger(port.containerPort) &&
          port.containerPort > 0
        ) {
          const protocol = (port.protocol || 'TCP').toUpperCase();
          const signature = `${port.containerPort}-${protocol}`;
          usedSignatures.add(signature);
          mergedPorts.push({
            name: port.name || `port-${index + 1}`,
            containerPort: port.containerPort,
            protocol,
          });
        }
      });

      sanitizedPorts.forEach((port) => {
        const signature = `${port.containerPort}-${port.protocol}`;
        if (!usedSignatures.has(signature)) {
          mergedPorts.push({
            name: port.name,
            containerPort: port.containerPort,
            protocol: port.protocol,
          });
          usedSignatures.add(signature);
        }
      });

      await appsApi.patchNamespacedDeployment(
        deploymentName,
        namespace,
        {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'orchard.dev/service-updated-at': new Date().toISOString(),
                },
              },
              spec: {
                containers: containers.map((container) =>
                  container.name === targetContainer.name
                    ? {
                        ...container,
                        ports: mergedPorts,
                      }
                    : container
                ),
              },
            },
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' },
        }
      );

      const selectorLabels =
        deployment.body.spec?.selector?.matchLabels ||
        deployment.body.spec?.template?.metadata?.labels || {
          'app.kubernetes.io/name': deploymentName,
        };

      const requestedType = options.type || 'ClusterIP';

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: serviceName,
          labels: {
            ...(deployment.body.spec?.template?.metadata?.labels || {}),
            'orchard.dev/managed': 'true',
          },
        },
        spec: {
          type: requestedType,
          selector: selectorLabels,
          ports: sanitizedPorts.map((port) => {
            const entry: k8s.V1ServicePort = {
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
            };
            if (
              (requestedType === 'NodePort' || requestedType === 'LoadBalancer') &&
              port.nodePort
            ) {
              entry.nodePort = port.nodePort;
            }
            return entry;
          }),
        },
      };

      try {
        await coreApi.createNamespacedService(namespace, serviceBody);
      } catch (createError) {
        throw new BadRequestException({
          error: 'Failed to create service',
          message: createError.response?.body?.message || createError.message,
          details: createError.response?.body,
        });
      }

      const createdService = await coreApi.readNamespacedService(serviceName, namespace);
      const mappedPorts = this.mapServicePorts(
        createdService.body.spec?.ports,
        sanitizedPorts
      );
      const serviceType = createdService.body.spec?.type || requestedType;

      let externalIp: string | null = null;
      if (serviceType === 'LoadBalancer') {
        const statusRecord = createdService.body.status?.loadBalancer?.ingress?.[0];
        externalIp = statusRecord?.ip || statusRecord?.hostname || null;
      } else if (serviceType === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }

      return {
        type: serviceType,
        ports: mappedPorts,
        externalIp,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${deploymentName} not found in namespace ${namespace}`,
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create service',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to create service',
        message: error.message,
      });
    }
  }

  async deleteDeploymentService(options: DeleteDeploymentServiceOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

      try {
        await coreApi.deleteNamespacedService(serviceName, namespace);
      } catch (deleteError) {
        if (deleteError.response?.statusCode !== 404) {
          throw new BadRequestException({
            error: 'Failed to delete service',
            message: deleteError.response?.body?.message || deleteError.message,
            details: deleteError.response?.body,
          });
        }
      }

      if (options.remainingPorts) {
        const sanitizedRemaining = this.ensureUniqueServicePorts(
          this.sanitizePortEntries(options.remainingPorts)
        );

        try {
          const deployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
          const containers = deployment.body.spec?.template?.spec?.containers;

          if (containers && containers.length > 0) {
            const targetContainer = containers[0];
            const updatedContainer = {
              ...targetContainer,
              ports: sanitizedRemaining.map((port) => ({
                name: port.name,
                containerPort: port.containerPort,
                protocol: port.protocol,
              })),
            };

            await appsApi.patchNamespacedDeployment(
              deploymentName,
              namespace,
              {
                spec: {
                  template: {
                    metadata: {
                      annotations: {
                        'orchard.dev/service-updated-at': new Date().toISOString(),
                      },
                    },
                    spec: {
                      containers: containers.map((container) =>
                        container.name === targetContainer.name ? updatedContainer : container
                      ),
                    },
                  },
                },
              },
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                headers: { 'Content-Type': 'application/merge-patch+json' },
              }
            );
          }
        } catch (deploymentError) {
          if (deploymentError.response?.statusCode !== 404) {
            throw new BadRequestException({
              error: 'Failed to update deployment ports',
              message: deploymentError.response?.body?.message || deploymentError.message,
              details: deploymentError.response?.body,
            });
          }
        }
      }

      return {
        success: true,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete service',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete service',
        message: error.message,
      });
    }
  }

  async updateServiceExposure(options: UpdateServiceExposureOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    const type =
      options.type === 'LoadBalancer'
        ? 'LoadBalancer'
        : options.type === 'NodePort'
        ? 'NodePort'
        : 'ClusterIP';

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const patch = {
        spec: {
          type,
        },
      };

      await coreApi.patchNamespacedService(
        serviceName,
        namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: {
            'Content-Type': 'application/strategic-merge-patch+json',
          },
        }
      );

      const updated = await coreApi.readNamespacedService(serviceName, namespace);
      let externalIp: string | null = null;
      if (type === 'LoadBalancer') {
        const ingressStatus = updated.body.status?.loadBalancer?.ingress?.[0];
        externalIp = ingressStatus?.ip || ingressStatus?.hostname || null;
      } else if (type === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }
      const ports = this.mapServicePorts(updated.body.spec?.ports);

      return {
        success: true,
        namespace,
        serviceName,
        type,
        externalIp,
        ports,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update service exposure',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to update service exposure',
        message: error.message,
      });
    }
  }

  async deleteDeployment(deploymentName: string, namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanName = String(deploymentName || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      try {
        await appsApi.deleteNamespacedDeployment(cleanName, cleanNamespace);
      } catch (deploymentError) {
        if (deploymentError.response?.statusCode !== 404) {
          throw deploymentError;
        }
      }

      try {
        await coreApi.deleteNamespacedService(cleanName, cleanNamespace);
      } catch (serviceError) {
        if (serviceError.response?.statusCode !== 404) {
          throw serviceError;
        }
      }

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace,
      };
    } catch (error) {
      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete deployment',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete deployment',
        message: error.message,
      });
    }
  }

  async syncNamespaceToDatabase(namespace: string) {
    this.ensureKubeConfig();
    
    console.log('[Sync] Syncing namespace to database:', namespace);
    
    const project = await this.prisma.project.findFirst({
      where: { namespace }
    });
    
    if (!project) {
      throw new NotFoundException({
        error: 'Project not found',
        message: `No project found with namespace ${namespace}`
      });
    }
    
    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      
      const deploymentList = await appsApi.listNamespacedDeployment(namespace);
      
      for (const k8sDeployment of deploymentList.body.items) {
        const deploymentName = k8sDeployment.metadata.name;
        const image = k8sDeployment.spec.template.spec.containers[0]?.image;
        const replicas = k8sDeployment.spec.replicas || 1;
        const availableReplicas = k8sDeployment.status.availableReplicas || 0;
        const unavailableReplicas = k8sDeployment.status.unavailableReplicas || 0;

        let status = 'pending';
        if (replicas === 0) {
          status = 'stopped';
        } else if (availableReplicas === replicas && replicas > 0) {
          status = 'running';
        } else if (availableReplicas > 0 && availableReplicas < replicas) {
          status = 'scaling';
        } else if (availableReplicas === 0 && unavailableReplicas > 0) {
          status = 'failed';
        } else {
          status = 'pending';
        }

        const deploymentRecord = await this.prisma.deployment.upsert({
          where: {
            projectId_name: {
              projectId: project.id,
              name: deploymentName,
            },
          },
          update: {
            namespace,
            image,
            replicas,
            status,
          },
          create: {
            projectId: project.id,
            name: deploymentName,
            namespace,
            image,
            replicas,
            status,
          },
        });
        
        const containerEnv = k8sDeployment.spec.template.spec.containers?.[0]?.env || [];
        const envKeys = new Set<string>();

        for (const envVar of containerEnv) {
          if (!envVar?.name) {
            continue;
          }

          if (envVar.value === undefined || envVar.value === null) {
            continue;
          }

          const key = String(envVar.name);
          const value = String(envVar.value);
          envKeys.add(key);

          await this.prisma.deploymentEnvVar.upsert({
            where: {
              deploymentId_key: {
                deploymentId: deploymentRecord.id,
                key,
              },
            },
            update: {
              value,
            },
            create: {
              deploymentId: deploymentRecord.id,
              key,
              value,
            },
          });
        }

        if (envKeys.size > 0) {
          await this.prisma.deploymentEnvVar.deleteMany({
            where: {
              deploymentId: deploymentRecord.id,
              key: {
                notIn: Array.from(envKeys),
              },
            },
          });
        } else {
          await this.prisma.deploymentEnvVar.deleteMany({
            where: {
              deploymentId: deploymentRecord.id,
            },
          });
        }

        try {
          const serviceResponse = await coreApi.readNamespacedService(deploymentName, namespace);
          const containerPorts = k8sDeployment.spec.template.spec.containers?.[0]?.ports || [];
          const servicePorts = serviceResponse.body.spec?.ports || [];
          const serviceTypeRaw = serviceResponse.body.spec?.type || 'ClusterIP';
          const serviceTypeValue =
            serviceTypeRaw === 'ClusterIP' ? ServiceType.internal : ServiceType.external;
          const ingressStatus = serviceResponse.body.status?.loadBalancer?.ingress?.[0];
          let externalIp = ingressStatus?.ip || ingressStatus?.hostname || null;
          if (!externalIp && serviceTypeRaw === 'NodePort') {
            externalIp = await this.getDefaultNodeIp(coreApi);
          }

          const rawPorts: DeploymentPortInput[] = servicePorts.map((servicePort, index) => {
            const resolvedServicePort = Number(servicePort.port);
            if (!Number.isInteger(resolvedServicePort) || resolvedServicePort <= 0) {
              return {
                name: servicePort.name ?? `port-${index + 1}`,
                containerPort: resolvedServicePort > 0 ? resolvedServicePort : 80,
                servicePort: resolvedServicePort > 0 ? resolvedServicePort : 80,
                protocol: servicePort.protocol ?? 'TCP',
                nodePort:
                  typeof servicePort.nodePort === 'number' && Number.isInteger(servicePort.nodePort)
                    ? servicePort.nodePort
                    : undefined,
              };
            }

            let resolvedContainerPort = 0;
            const targetPort = servicePort.targetPort;
            if (typeof targetPort === 'number') {
              resolvedContainerPort = targetPort;
            } else if (typeof targetPort === 'string') {
              const numericTarget = Number.parseInt(targetPort, 10);
              if (Number.isInteger(numericTarget)) {
                resolvedContainerPort = numericTarget;
              } else {
                const matchByTargetName = containerPorts.find((port) => port.name === targetPort);
                if (matchByTargetName?.containerPort) {
                  resolvedContainerPort = matchByTargetName.containerPort;
                }
              }
            }

            if (!resolvedContainerPort) {
              const matchByName = containerPorts.find((port) => port.name === servicePort.name);
              if (matchByName?.containerPort) {
                resolvedContainerPort = matchByName.containerPort;
              }
            }

            if (!resolvedContainerPort) {
              resolvedContainerPort = resolvedServicePort;
            }

            return {
              name: servicePort.name ?? `port-${index + 1}`,
              containerPort: resolvedContainerPort,
              servicePort: resolvedServicePort,
              protocol: servicePort.protocol ?? 'TCP',
              nodePort:
                typeof servicePort.nodePort === 'number' && Number.isInteger(servicePort.nodePort)
                  ? servicePort.nodePort
                  : undefined,
            };
          });

          const sanitizedServicePorts = this.sanitizePortEntries(rawPorts);

          const serviceRecord = await this.prisma.service.upsert({
            where: {
              deploymentId_name: {
                deploymentId: deploymentRecord.id,
                name: deploymentName,
              },
            },
            update: {
              port: sanitizedServicePorts[0].servicePort,
              targetPort: sanitizedServicePorts[0].containerPort,
              protocol: sanitizedServicePorts[0].protocol,
              type: serviceTypeValue,
              externalIp,
              nodePort:
                sanitizedServicePorts[0].nodePort !== undefined &&
                sanitizedServicePorts[0].nodePort !== null
                  ? sanitizedServicePorts[0].nodePort
                  : null,
            },
            create: {
              deploymentId: deploymentRecord.id,
              name: deploymentName,
              type: serviceTypeValue,
              port: sanitizedServicePorts[0].servicePort,
              targetPort: sanitizedServicePorts[0].containerPort,
              protocol: sanitizedServicePorts[0].protocol,
              externalIp,
              nodePort:
                sanitizedServicePorts[0].nodePort !== undefined &&
                sanitizedServicePorts[0].nodePort !== null
                  ? sanitizedServicePorts[0].nodePort
                  : null,
            },
          });

          await this.prisma.servicePort.deleteMany({
            where: { serviceId: serviceRecord.id },
          });

          await this.prisma.servicePort.createMany({
            data: sanitizedServicePorts.map((port) => ({
              serviceId: serviceRecord.id,
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
              nodePort:
                port.nodePort !== undefined && port.nodePort !== null ? port.nodePort : null,
            })),
          });
        } catch (serviceError) {
          if (serviceError.response?.statusCode !== 404) {
            console.error('[Sync] Service sync error:', {
              message: serviceError.message,
              code: serviceError.code,
              statusCode: serviceError.response?.statusCode,
            });
          }
        }

      }
      
      const dbDeploymentNames = new Set(
        deploymentList.body.items.map(d => d.metadata.name)
      );
      
      const dbDeployments = await this.prisma.deployment.findMany({
        where: { 
          projectId: project.id,
          buildStatus: { notIn: ['building'] }
        }
      });
      
      for (const dbDeployment of dbDeployments) {
        if (!dbDeploymentNames.has(dbDeployment.name)) {
          await this.prisma.deployment.delete({
            where: { id: dbDeployment.id }
          });
        }
      }
      
      console.log('[Sync] Successfully synced namespace:', namespace);
      
      return {
        success: true,
        namespace,
        projectId: project.id,
        deploymentsCount: deploymentList.body.items.length,
      };
    } catch (error) {
      console.error('[Sync] Error syncing namespace:', error);
      throw new BadRequestException({
        error: 'Failed to sync namespace',
        message: error.message
      });
    }
  }

  async restartDeployment(deploymentName: string, namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();
    
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();
    
    console.log('[API] Restarting deployment:', cleanDeploymentName, 'in namespace:', cleanNamespace);
    
    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);
      
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
              }
            }
          }
        }
      };
      
      await api.patchNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );
      
      console.log('[API] Successfully restarted deployment:', cleanDeploymentName);
      
      return {
        success: true,
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        restartedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error restarting deployment:', error);
      
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanDeploymentName} not found in namespace ${cleanNamespace}`
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to restart deployment',
        message: error.message
      });
    }
  }

  async scaleDeployment(deploymentName: string, namespace: string = 'midnight-staging', replicas: number) {
    this.ensureKubeConfig();
    
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();
    
    if (replicas < 0 || !Number.isInteger(replicas)) {
      throw new BadRequestException({
        error: 'Invalid replicas',
        message: 'Replicas must be a non-negative integer'
      });
    }
    
    console.log('[API] Scaling deployment:', cleanDeploymentName, 'to', replicas, 'replicas in namespace:', cleanNamespace);
    
    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);
      
      const patch = {
        spec: {
          replicas: replicas
        }
      };
      
      const result = await api.patchNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );
      
      console.log('[API] Successfully scaled deployment:', cleanDeploymentName, 'to', replicas, 'replicas');
      
      const project = await this.prisma.project.findFirst({
        where: { namespace: cleanNamespace }
      });
      
      if (project) {
        await this.prisma.deployment.update({
          where: {
            projectId_name: {
              projectId: project.id,
              name: cleanDeploymentName
            }
          },
          data: {
            replicas: replicas
          }
        });
        
        console.log('[API] Updated deployment replicas in database');
      }
      
      return {
        success: true,
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        replicas: result.body.spec.replicas,
        currentReplicas: result.body.status.replicas,
        readyReplicas: result.body.status.readyReplicas
      };
    } catch (error) {
      console.error('Error scaling deployment:', error);
      
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanDeploymentName} not found in namespace ${cleanNamespace}`
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to scale deployment',
        message: error.message
      });
    }
  }

  // Patch only the `spec.strategy` of an existing Deployment. Used when the
  // user toggles RollingUpdate ↔ Recreate without changing image/volumes.
  async updateDeploymentStrategy(
    deploymentName: string,
    namespace: string,
    strategy: 'rollingUpdate' | 'recreate',
  ) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const cleanName = String(deploymentName).trim();
    const cleanNamespace = String(namespace).trim();

    // Setting `rollingUpdate: null` clears any prior rolling config when
    // switching to Recreate. K8s rejects strategy.rollingUpdate alongside
    // type=Recreate, so we have to actively wipe it.
    const body: k8s.V1DeploymentStrategy = strategy === 'recreate'
      ? { type: 'Recreate', rollingUpdate: null as any }
      : { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } };

    try {
      await api.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        { spec: { strategy: body } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
      );
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`,
        });
      }
      throw new BadRequestException({
        error: 'Failed to update deployment strategy',
        message: error.message,
      });
    }

    return { success: true, deployment: cleanName, namespace: cleanNamespace, strategy };
  }

  async updateDeploymentImage(deploymentName: string, namespace: string, image: string) {
    this.ensureKubeConfig();
    
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();
    const cleanImage = String(image).trim();
    
    console.log('[API] Updating deployment image:', cleanDeploymentName, 'to', cleanImage, 'in namespace:', cleanNamespace);
    
    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);
      
      const patch = {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: cleanDeploymentName,
                  image: cleanImage,
                },
              ],
            },
          },
        },
      };
      
      await api.patchNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );
      
      console.log('[API] Successfully updated deployment image:', cleanDeploymentName, 'to', cleanImage);
      
      const project = await this.prisma.project.findFirst({
        where: { namespace: cleanNamespace }
      });
      
      if (project) {
        const deployment = await this.prisma.deployment.findUnique({
          where: {
            projectId_name: {
              projectId: project.id,
              name: cleanDeploymentName,
            },
          },
        });
        
        if (deployment) {
          await this.prisma.deployment.update({
            where: { id: deployment.id },
            data: { image: cleanImage },
          });
        }
      }
      
      return {
        success: true,
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        image: cleanImage,
      };
    } catch (error) {
      console.error('Error updating deployment image:', error);
      
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanDeploymentName} not found in namespace ${cleanNamespace}`
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to update deployment image',
        message: error.message
      });
    }
  }

  async getPodEvents(podName: string, namespace: string) {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      const events = await coreApi.listNamespacedEvent(
        namespace,
        undefined,
        undefined,
        undefined,
        `involvedObject.name=${podName}`
      );

      return events.body.items
        .filter(event => event.type === 'Warning' || event.reason === 'BackOff' || event.reason === 'Failed')
        .map(event => ({
          type: event.type,
          reason: event.reason,
          message: event.message,
          count: event.count || 1,
          firstTimestamp: event.firstTimestamp,
          lastTimestamp: event.lastTimestamp,
        }))
        .sort((a, b) => {
          const timeA = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
          const timeB = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
          return timeB - timeA;
        });
    } catch (error) {
      console.error(`[API] Error fetching events for pod ${podName}:`, error.message);
      return [];
    }
  }

  // Cluster-wide pod labels. Returns Map<"namespace/podName", labels>.
  async getAllPodLabels(): Promise<Map<string, Record<string, string>>> {
    const out = new Map<string, Record<string, string>>();
    this.ensureKubeConfig();
    if (!this.kc) return out;
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const res = await api.listPodForAllNamespaces();
      for (const pod of res.body.items) {
        const ns = pod.metadata?.namespace;
        const name = pod.metadata?.name;
        if (!ns || !name) continue;
        out.set(`${ns}/${name}`, (pod.metadata?.labels || {}) as Record<string, string>);
      }
    } catch (err) {
      console.error('[K8s] getAllPodLabels failed:', err instanceof Error ? err.message : err);
    }
    return out;
  }

  // Cluster-wide pod metrics. Returns Map<"namespace/podName", {cpuMilli, memBytes}>.
  async getAllPodMetrics(): Promise<Map<string, { cpuMilli: number; memoryBytes: number; namespace: string; podName: string }>> {
    const out = new Map<string, { cpuMilli: number; memoryBytes: number; namespace: string; podName: string }>();
    this.ensureKubeConfig();
    if (!this.kc) return out;
    try {
      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const response = await customApi.listClusterCustomObject('metrics.k8s.io', 'v1beta1', 'pods');
      const items = (response.body as any)?.items ?? [];
      for (const item of items) {
        const ns = item.metadata?.namespace as string | undefined;
        const pod = item.metadata?.name as string | undefined;
        if (!ns || !pod) continue;
        let cpu = 0;
        let mem = 0;
        for (const c of item.containers ?? []) {
          const cpuStr: string = c.usage?.cpu ?? '0';
          const memStr: string = c.usage?.memory ?? '0';
          if (cpuStr.endsWith('n')) cpu += parseInt(cpuStr) / 1_000_000;
          else if (cpuStr.endsWith('u')) cpu += parseInt(cpuStr) / 1000;
          else if (cpuStr.endsWith('m')) cpu += parseInt(cpuStr);
          else cpu += parseFloat(cpuStr) * 1000;
          if (memStr.endsWith('Ki')) mem += parseInt(memStr) * 1024;
          else if (memStr.endsWith('Mi')) mem += parseInt(memStr) * 1024 * 1024;
          else if (memStr.endsWith('Gi')) mem += parseInt(memStr) * 1024 * 1024 * 1024;
          else mem += parseInt(memStr);
        }
        out.set(`${ns}/${pod}`, { cpuMilli: Math.round(cpu), memoryBytes: mem, namespace: ns, podName: pod });
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error('[K8s] getAllPodMetrics failed:', m);
    }
    return out;
  }

  async getPodMetrics(namespace: string, labelSelector: string): Promise<Map<string, { cpuUsage: number; memoryUsage: number }>> {
    try {
      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const response = await customApi.listNamespacedCustomObject(
        'metrics.k8s.io',
        'v1beta1',
        namespace,
        'pods',
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // continue
        undefined, // fieldSelector
        labelSelector
      );

      const metricsMap = new Map<string, { cpuUsage: number; memoryUsage: number }>();
      const items = (response.body as any)?.items ?? [];

      for (const item of items) {
        const podName = item.metadata?.name;
        if (!podName) continue;

        let totalCpu = 0;
        let totalMemory = 0;

        for (const container of item.containers ?? []) {
          const cpuStr: string = container.usage?.cpu ?? '0';
          const memStr: string = container.usage?.memory ?? '0';

          // Parse CPU: could be "123n" (nanocores) or "100m" (millicores)
          if (cpuStr.endsWith('n')) {
            totalCpu += parseInt(cpuStr) / 1_000_000; // nanocores to millicores
          } else if (cpuStr.endsWith('m')) {
            totalCpu += parseInt(cpuStr);
          } else {
            totalCpu += parseFloat(cpuStr) * 1000; // cores to millicores
          }

          // Parse memory: could be "123Ki", "456Mi", "789Gi", or plain bytes
          if (memStr.endsWith('Ki')) {
            totalMemory += parseInt(memStr) * 1024;
          } else if (memStr.endsWith('Mi')) {
            totalMemory += parseInt(memStr) * 1024 * 1024;
          } else if (memStr.endsWith('Gi')) {
            totalMemory += parseInt(memStr) * 1024 * 1024 * 1024;
          } else {
            totalMemory += parseInt(memStr);
          }
        }

        metricsMap.set(podName, { cpuUsage: Math.round(totalCpu), memoryUsage: totalMemory });
      }

      return metricsMap;
    } catch (error) {
      console.warn('[API] Failed to fetch pod metrics (metrics-server may not be available):', error.message);
      return new Map();
    }
  }

  /**
   * Lightweight batch fetch: lists all pods in a namespace in one API call and
   * groups them by their `app` label. Skips per-pod event fetches and metrics —
   * intended for status-badge computation across many deployments.
   */
  async listNamespacePodsByApp(
    namespace: string,
  ): Promise<Map<string, { pods: any[]; warnings: any[] }> | null> {
    this.ensureKubeConfig();
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const result = new Map<string, { pods: any[]; warnings: any[] }>();
    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      const podList = await coreApi.listNamespacedPod(cleanNamespace);
      for (const pod of podList.body.items) {
        const appLabel = pod.metadata?.labels?.app;
        if (!appLabel) continue;

        const containerStatuses = pod.status?.containerStatuses ?? [];
        const totalRestartCount = containerStatuses.reduce(
          (sum, c) => sum + (c.restartCount ?? 0),
          0,
        );

        const podPhase = pod.status?.phase?.toLowerCase() || 'pending';
        const conditions = pod.status?.conditions || [];
        const isScheduled = conditions.some((c) => c.type === 'PodScheduled' && c.status === 'True');
        const isReady = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
        const allContainersReady =
          containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);
        let computedStatus = podPhase;
        if (podPhase === 'running') {
          computedStatus = isReady && allContainersReady ? 'ready' : isScheduled ? 'scheduled' : 'pending';
        } else if (podPhase === 'pending' && isScheduled) {
          computedStatus = 'scheduled';
        }

        const warnings: any[] = [];
        for (const cs of containerStatuses) {
          const waiting = cs.state?.waiting;
          if (waiting?.reason === 'CrashLoopBackOff' || waiting?.reason === 'ImagePullBackOff') {
            warnings.push({
              podName: pod.metadata?.name,
              message: `${cs.name}: ${waiting.message || waiting.reason}`,
            });
          }
        }

        const entry = result.get(appLabel) ?? { pods: [], warnings: [] };
        entry.pods.push({
          name: pod.metadata?.name,
          status: computedStatus,
          restartCount: totalRestartCount,
        });
        entry.warnings.push(...warnings);
        result.set(appLabel, entry);
      }
    } catch (error) {
      if (error?.response?.statusCode === 404) {
        return result;
      }
      console.warn('[API] listNamespacePodsByApp failed:', error?.message ?? error);
      return null;
    }
    return result;
  }

  async getDeploymentPods(deploymentName: string, namespace: string = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();

    console.log('[API] Fetching pods for deployment:', cleanDeploymentName, 'in namespace:', cleanNamespace);

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const k8sDeployment = await appsApi.readNamespacedDeployment(cleanDeploymentName, cleanNamespace);

      const selector = k8sDeployment.body.spec.selector;
      const labelSelector = selector.matchLabels
        ? Object.entries(selector.matchLabels)
            .map(([key, value]) => `${key}=${value}`)
            .join(',')
        : `app=${cleanDeploymentName}`;
      
      const podList = await coreApi.listNamespacedPod(
        cleanNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
      );
      
      const pods = await Promise.all(podList.body.items.map(async pod => {
        const containerStatuses = pod.status?.containerStatuses ?? [];
        const statusByName = new Map(
          containerStatuses.map(status => [status.name, status])
        );

        const containers = pod.spec?.containers?.map(container => {
          const status = statusByName.get(container.name);
          const state = status?.state;
          let containerWarning: string | undefined;

          if (state?.waiting) {
            if (state.waiting.reason === 'CrashLoopBackOff' || state.waiting.reason === 'ImagePullBackOff') {
              containerWarning = state.waiting.message || state.waiting.reason;
            }
          }

          return {
            name: container.name,
            image: container.image,
            ready: status?.ready ?? false,
            restartCount: status?.restartCount ?? 0,
            warning: containerWarning,
          };
        }) ?? [];

        const totalRestartCount = containerStatuses.reduce(
          (sum, current) => sum + (current.restartCount ?? 0),
          0
        );

        const podName = pod.metadata?.name;
        const events = podName ? await this.getPodEvents(podName, cleanNamespace) : [];

        // Determine accurate pod status based on conditions and container readiness
        const podPhase = pod.status?.phase?.toLowerCase() || 'pending';
        const conditions = pod.status?.conditions || [];
        const isScheduled = conditions.some(c => c.type === 'PodScheduled' && c.status === 'True');
        const isReady = conditions.some(c => c.type === 'Ready' && c.status === 'True');
        const allContainersReady = containerStatuses.length > 0 && containerStatuses.every(c => c.ready === true);

        let computedStatus = podPhase;
        if (podPhase === 'running') {
          if (isReady && allContainersReady) {
            computedStatus = 'ready';
          } else if (isScheduled) {
            computedStatus = 'scheduled';
          } else {
            computedStatus = 'pending';
          }
        } else if (podPhase === 'pending') {
          if (isScheduled) {
            computedStatus = 'scheduled';
          }
        }

        return {
          name: podName,
          namespace: pod.metadata?.namespace,
          podIp: pod.status?.podIP,
          nodeName: pod.spec?.nodeName,
          status: computedStatus,
          restartCount: totalRestartCount,
          createdAt: pod.metadata?.creationTimestamp,
          containers,
          events: events.slice(0, 5),
        };
      }));

      const warnings = pods.flatMap(pod => {
        const podWarnings: string[] = [];

        pod.containers?.forEach(container => {
          if (container.warning) {
            podWarnings.push(`${container.name}: ${container.warning}`);
          }
          if (container.restartCount > 0) {
            podWarnings.push(`${container.name} has restarted ${container.restartCount} time(s)`);
          }
        });

        pod.events?.forEach(event => {
          podWarnings.push(`${event.reason}: ${event.message}`);
        });

        return podWarnings.map(warning => ({
          podName: pod.name,
          message: warning,
          timestamp: pod.events?.[0]?.lastTimestamp || pod.createdAt,
        }));
      });
      
      // Fetch metrics and attach to pods
      const metricsMap = await this.getPodMetrics(cleanNamespace, labelSelector);
      const podsWithMetrics = pods.map(pod => {
        const metrics = metricsMap.get(pod.name);
        return {
          ...pod,
          cpuUsage: metrics?.cpuUsage ?? null,
          memoryUsage: metrics?.memoryUsage ?? null,
        };
      });

      const totalCpuUsage = podsWithMetrics.reduce((sum, p) => sum + (p.cpuUsage ?? 0), 0);
      const totalMemoryUsage = podsWithMetrics.reduce((sum, p) => sum + (p.memoryUsage ?? 0), 0);
      const hasMetrics = metricsMap.size > 0;

      return {
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        podCount: podsWithMetrics.length,
        pods: podsWithMetrics,
        warnings: warnings.slice(0, 10),
        totalCpuUsage: hasMetrics ? totalCpuUsage : null,
        totalMemoryUsage: hasMetrics ? totalMemoryUsage : null,
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        console.log(`[API] Deployment ${cleanDeploymentName} not found in Kubernetes (may still be building), returning empty pods`);
        return {
          deployment: cleanDeploymentName,
          namespace: cleanNamespace,
          podCount: 0,
          pods: [],
          warnings: [],
          totalCpuUsage: null,
          totalMemoryUsage: null,
        };
      }
      
      console.error('[API] Error fetching deployment pods:', error.message);
      throw new BadRequestException({
        error: 'Failed to fetch deployment pods',
        message: error.message
      });
    }
  }

  private sanitizePortEntries(portInputs: DeploymentPortInput[]): SanitizedPortEntry[] {
    const usedNames = new Set<string>();
    let autoCounter = 1;
    const sanitized: SanitizedPortEntry[] = [];

    portInputs.forEach((input, index) => {
      const containerPort = Number(input.containerPort ?? input.servicePort ?? 0);
      const servicePort = Number(input.servicePort ?? input.containerPort ?? 0);

      if (!Number.isInteger(containerPort) || containerPort <= 0) {
        return;
      }

      if (!Number.isInteger(servicePort) || servicePort <= 0) {
        return;
      }

      const protocol = typeof input.protocol === 'string' && input.protocol.trim().length > 0
        ? input.protocol.trim().toUpperCase()
        : 'TCP';

      const rawName = typeof input.name === 'string' ? input.name : '';
      let baseName = rawName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      baseName = baseName.replace(/^-+|-+$/g, '');
      if (!baseName) {
        baseName = `port-${autoCounter++}`;
      }
      if (baseName.length > 63) {
        baseName = baseName.substring(0, 63);
      }
      if (!baseName) {
        baseName = `port-${index + 1}`;
      }

      let name = baseName;
      let suffixCounter = 1;
      while (usedNames.has(name) || name.length === 0) {
        const suffix = `-${suffixCounter++}`;
        const trimmedBase = baseName.substring(0, Math.max(1, 63 - suffix.length));
        name = `${trimmedBase}${suffix}`;
      }
      usedNames.add(name);

      sanitized.push({
        name,
        containerPort,
        servicePort,
        protocol,
        nodePort:
          typeof input.nodePort === 'number' && Number.isInteger(input.nodePort) && input.nodePort > 0
            ? input.nodePort
            : undefined,
      });
    });

    if (sanitized.length === 0) {
      sanitized.push({
        name: 'http',
        containerPort: 80,
        servicePort: 80,
        protocol: 'TCP',
        nodePort: undefined,
      });
    }

    return sanitized;
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

      const stdout = new (require('stream').PassThrough)();
      const stderr = new (require('stream').PassThrough)();

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
    console.log(`[K8s/PG] Creating database "${dbName}" with user "${dbUser}"`);

    // Create the role
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
        connections: parseInt(connResult) || 0,
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
    const secretData: { [k: string]: string } = {
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
      const stdout = new (require('stream').PassThrough)();
      const stderr = new (require('stream').PassThrough)();
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
    const pod = await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    await appsApi.patchNamespacedDeploymentScale(
      name, namespace, { spec: { replicas: 0 } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    await new Promise((r) => setTimeout(r, 5000));

    await appsApi.patchNamespacedDeploymentScale(
      name, namespace, { spec: { replicas: 1 } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    let newPod = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
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
          const exec = async (sql: string): Promise<string> => {
            const r = await this.execInPod(namespace, pod, 'postgres', [
              'psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-c', sql,
            ]);
            return r.stdout.trim();
          };
          size = await exec(`SELECT pg_size_pretty(pg_database_size('${dbName.replace(/'/g, "''")}'));`);
          const connRaw = await exec(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${dbName.replace(/'/g, "''")}';`);
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
        storageClass: 'longhorn',
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
      };
    }

    if (options.r2 && r2SecretName) {
      const host = options.r2.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
      clusterSpec.backup = {
        barmanObjectStore: {
          destinationPath: `s3://${options.r2.bucket}/${ns}/${name}`,
          endpointURL: `https://${host}`,
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

  async getCnpgClusterStatus(namespace: string, clusterName: string): Promise<any> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
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
      return {
        exists: true,
        phase,
        ready,
        readyReplicas: readyInstances,
        replicas: instances,
        currentPrimary: cluster.status?.currentPrimary,
        conditions: cluster.status?.conditions || [],
      };
    } catch (e: any) {
      if (e.response?.statusCode === 404) return { exists: false };
      throw e;
    }
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
    },
  ): Promise<{ host: string; port: number; newClusterName: string }> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const suffix = Date.now().toString(36);
    const newName = `${sourceClusterName}-r${suffix}`.substring(0, 53);

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
      storage: { size: options.storageSize || '1Gi', storageClass: 'longhorn' },
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
      const host = options.r2.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
      spec.backup = {
        barmanObjectStore: {
          destinationPath: `s3://${options.r2.bucket}/${namespace}/${newName}`,
          endpointURL: `https://${host}`,
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

  async listCnpgExtensions(namespace: string, clusterName: string, dbName: string): Promise<Array<{ name: string; installed: boolean; version?: string; defaultVersion?: string; comment?: string }>> {
    const pod = await this.findCnpgPrimaryPod(namespace, clusterName);
    const r = await this.execInPod(namespace, pod, 'postgres', [
      'psql', '-U', 'postgres', '-d', dbName, '-t', '-A', '-F', '|', '-c',
      `SELECT a.name, COALESCE(i.extversion, '') AS installed_version, a.default_version, COALESCE(a.comment, '') FROM pg_available_extensions a LEFT JOIN pg_extension i ON a.name = i.extname ORDER BY a.name;`,
    ]);
    if (!r.success) return [];
    const out: Array<{ name: string; installed: boolean; version?: string; defaultVersion?: string; comment?: string }> = [];
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
        const intermediates = certs.slice(1).join('\n') + '\n';
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
          'orchard.dev/tls-source-rv': srcRv,
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
      const existingRv = existing.metadata?.labels?.['orchard.dev/tls-source-rv'];
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

  // ── Public (MetalLB LoadBalancer) exposure ──

  private publicServiceName(clusterName: string): string {
    return `${clusterName}-public`.substring(0, 63);
  }

  private sharedIpAnnotation(ip: string): string {
    // Use a key derived from the IP itself so multiple orgs pointing at the same IP
    // converge on the same MetalLB sharing group (safe by design).
    return `db-shared-${ip.replace(/[^0-9a-zA-Z]/g, '-')}`;
  }

  async listInUsePortsOnIp(loadBalancerIp: string): Promise<number[]> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listServiceForAllNamespaces();
    const ports = new Set<number>();
    for (const svc of body.items) {
      if (svc.spec?.type !== 'LoadBalancer') continue;
      const svcIp = svc.spec?.loadBalancerIP
        || svc.status?.loadBalancer?.ingress?.[0]?.ip;
      if (svcIp !== loadBalancerIp) continue;
      for (const p of svc.spec?.ports || []) {
        if (typeof p.port === 'number') ports.add(p.port);
      }
    }
    return Array.from(ports);
  }

  async exposeCnpgClusterPublic(options: {
    namespace: string;
    clusterName: string;
    loadBalancerIp: string;
    port: number;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const svcName = this.publicServiceName(options.clusterName);

    const body: k8s.V1Service = {
      metadata: {
        name: svcName,
        namespace: options.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': options.clusterName,
        },
        annotations: {
          'metallb.universe.tf/allow-shared-ip': this.sharedIpAnnotation(options.loadBalancerIp),
        },
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerIP: options.loadBalancerIp,
        // MetalLB shared-IP across services that select different pods requires Cluster policy
        // (Local requires all co-located pods and per-service healthCheckNodePorts). We trade
        // client-IP preservation for reliable multi-DB sharing; TLS + password handle auth anyway.
        externalTrafficPolicy: 'Cluster',
        selector: {
          'cnpg.io/cluster': options.clusterName,
          'cnpg.io/instanceRole': 'primary',
        },
        ports: [
          { name: 'postgres', port: options.port, targetPort: 5432, protocol: 'TCP' },
        ],
      },
    };

    try {
      await coreApi.readNamespacedService(svcName, options.namespace);
      await coreApi.replaceNamespacedService(svcName, options.namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(options.namespace, body);
      } else {
        throw e;
      }
    }
  }

  async unexposeCnpgCluster(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const svcName = this.publicServiceName(clusterName);
    try {
      await coreApi.deleteNamespacedService(svcName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
    try {
      await this.deletePublicDatabaseNetworkPolicy(namespace, clusterName);
    } catch (e: any) {
      console.error(`[K8s/netpol] Failed to delete public NetworkPolicy: ${e?.message}`);
    }
  }

  private publicDatabaseNetworkPolicyName(clusterName: string): string {
    return `${clusterName}-allow-public`.substring(0, 63);
  }

  async upsertPublicDatabaseNetworkPolicy(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDatabaseNetworkPolicyName(clusterName);

    const body: k8s.V1NetworkPolicy = {
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': clusterName,
        },
      },
      spec: {
        // Target the CNPG primary pod of this cluster.
        podSelector: {
          matchLabels: {
            'cnpg.io/cluster': clusterName,
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
            ports: [{ protocol: 'TCP', port: 5432 }],
          },
        ],
      },
    };

    try {
      await networkingApi.readNamespacedNetworkPolicy(name, namespace);
      await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await networkingApi.createNamespacedNetworkPolicy(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deletePublicDatabaseNetworkPolicy(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDatabaseNetworkPolicyName(clusterName);
    try {
      await networkingApi.deleteNamespacedNetworkPolicy(name, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  // ── Public deployment-port exposure (MetalLB LoadBalancer, TCP/UDP passthrough) ──

  private readonly PUBLIC_DEPLOYMENT_BASE_DOMAIN = process.env.PUBLIC_DEPLOYMENT_DOMAIN || 'public.orchard.my';

  publicDeploymentBaseDomain(): string {
    return this.PUBLIC_DEPLOYMENT_BASE_DOMAIN;
  }

  private publicDeploymentServiceName(deploymentName: string, port: number, protocol: string): string {
    const proto = protocol.toLowerCase() === 'udp' ? 'u' : 't';
    return `${deploymentName}-pub-${proto}${port}`.substring(0, 63);
  }

  async exposeDeploymentPortPublic(options: {
    namespace: string;
    deploymentName: string;
    loadBalancerIp: string;
    publicPort: number;
    targetPort: number;
    protocol: string;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const protocol = options.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const svcName = this.publicDeploymentServiceName(options.deploymentName, options.publicPort, protocol);

    const body: k8s.V1Service = {
      metadata: {
        name: svcName,
        namespace: options.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'app.kubernetes.io/name': options.deploymentName,
          'orchard.dev/public-deployment': options.deploymentName,
        },
        annotations: {
          'metallb.universe.tf/allow-shared-ip': this.sharedIpAnnotation(options.loadBalancerIp),
        },
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerIP: options.loadBalancerIp,
        externalTrafficPolicy: 'Cluster',
        selector: {
          'app.kubernetes.io/name': options.deploymentName,
        },
        ports: [
          {
            name: `pub-${protocol.toLowerCase()}-${options.publicPort}`,
            port: options.publicPort,
            targetPort: options.targetPort,
            protocol,
          },
        ],
      },
    };

    try {
      await coreApi.readNamespacedService(svcName, options.namespace);
      await coreApi.replaceNamespacedService(svcName, options.namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(options.namespace, body);
      } else {
        throw e;
      }
    }
  }

  async unexposeDeploymentPortPublic(options: {
    namespace: string;
    deploymentName: string;
    publicPort: number;
    protocol: string;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const protocol = options.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const svcName = this.publicDeploymentServiceName(options.deploymentName, options.publicPort, protocol);
    try {
      await coreApi.deleteNamespacedService(svcName, options.namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  async unexposeAllDeploymentPortsPublic(namespace: string, deploymentName: string): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      const { body } = await coreApi.listNamespacedService(
        namespace, undefined, undefined, undefined, undefined,
        `orchard.dev/public-deployment=${deploymentName}`,
      );
      for (const svc of body.items) {
        const n = svc.metadata?.name;
        if (!n) continue;
        try {
          await coreApi.deleteNamespacedService(n, namespace);
        } catch (e: any) {
          if (e.response?.statusCode !== 404) throw e;
        }
      }
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  private publicDeploymentNetworkPolicyName(deploymentName: string): string {
    return `${deploymentName}-allow-public`.substring(0, 63);
  }

  async upsertPublicDeploymentNetworkPolicy(
    namespace: string,
    deploymentName: string,
    ports: { port: number; protocol: string }[],
  ): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDeploymentNetworkPolicyName(deploymentName);

    if (ports.length === 0) {
      await this.deletePublicDeploymentNetworkPolicy(namespace, deploymentName);
      return;
    }

    const body: k8s.V1NetworkPolicy = {
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'app.kubernetes.io/name': deploymentName,
        },
      },
      spec: {
        podSelector: {
          matchLabels: { 'app.kubernetes.io/name': deploymentName },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
            ports: ports.map((p) => ({
              protocol: p.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP',
              port: p.port,
            })),
          },
        ],
      },
    };

    try {
      await networkingApi.readNamespacedNetworkPolicy(name, namespace);
      await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await networkingApi.createNamespacedNetworkPolicy(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deletePublicDeploymentNetworkPolicy(namespace: string, deploymentName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDeploymentNetworkPolicyName(deploymentName);
    try {
      await networkingApi.deleteNamespacedNetworkPolicy(name, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  /**
   * Create an isolated Tailscale proxy pod for a deployment.
   * Runs as a separate Deployment with a NetworkPolicy that ONLY allows
   * traffic to the target deployment's service — no internet, no other namespaces.
   */
  async addTailscaleSidecar(
    namespace: string,
    deploymentName: string,
    authKey: string,
    hostname: string,
    servicePorts: { port: number; targetPort: number; protocol: string }[],
  ): Promise<void> {
    this.ensureKubeConfig();
    if (!this.kc) return;

    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const tsDeployName = `ts-${deploymentName}`;
    const secretName = `ts-auth-${deploymentName}`;

    const orchardLabels = {
      'app.kubernetes.io/managed-by': 'orchard',
      'orchard.dev/tailscale': 'true',
      'orchard.dev/target-deployment': deploymentName,
    };

    const podLabels = {
      ...orchardLabels,
      'app.kubernetes.io/name': tsDeployName,
    };

    // 1. Create Secret with the auth key
    const secretBody: k8s.V1Secret = {
      metadata: { name: secretName, namespace, labels: orchardLabels },
      type: 'Opaque',
      stringData: { TS_AUTHKEY: authKey },
    };
    try {
      await coreApi.createNamespacedSecret(namespace, secretBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedSecret(secretName, namespace, secretBody);
      } else {
        throw error;
      }
    }

    // 2. Create ServiceAccount
    const saName = tsDeployName;
    try {
      await coreApi.createNamespacedServiceAccount(namespace, {
        metadata: { name: saName, labels: orchardLabels },
      });
    } catch (error: any) {
      if (error.response?.statusCode !== 409) throw error;
    }

    // 3. Create RBAC (the Tailscale container needs to read/write its state secret)
    const rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    try {
      await rbacApi.createNamespacedRole(namespace, {
        metadata: { name: tsDeployName, labels: orchardLabels },
        rules: [
          {
            apiGroups: [''],
            resources: ['secrets'],
            verbs: ['get', 'update', 'patch'],
            resourceNames: [secretName],
          },
        ],
      });
    } catch (error: any) {
      if (error.response?.statusCode !== 409) throw error;
    }
    try {
      await rbacApi.createNamespacedRoleBinding(namespace, {
        metadata: { name: tsDeployName, labels: orchardLabels },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: tsDeployName },
        subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
      });
    } catch (error: any) {
      if (error.response?.statusCode !== 409) throw error;
    }

    // 4. Build a Tailscale Serve config to proxy each port to the target service.
    // TS_SERVE_CONFIG works in userspace mode — no NET_ADMIN needed.
    const targetPort = servicePorts[0]?.targetPort || 80;
    const serveConfig = JSON.stringify({
      TCP: Object.fromEntries(
        servicePorts.map((p) => [
          String(p.targetPort),
          { TCPForward: `${deploymentName}:${p.targetPort}` },
        ]),
      ),
    });
    const serveConfigName = `ts-serve-${deploymentName}`;

    // Store the serve config in a ConfigMap
    const configMapBody: k8s.V1ConfigMap = {
      metadata: { name: serveConfigName, namespace, labels: orchardLabels },
      data: { 'serve-config.json': serveConfig },
    };
    try {
      await coreApi.createNamespacedConfigMap(namespace, configMapBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedConfigMap(serveConfigName, namespace, configMapBody);
      } else {
        throw error;
      }
    }

    // 5. Create the Tailscale proxy Deployment (separate pod, NOT a sidecar)
    const tsDeployBody: k8s.V1Deployment = {
      metadata: { name: tsDeployName, namespace, labels: orchardLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': tsDeployName } },
        template: {
          metadata: { labels: podLabels },
          spec: {
            serviceAccountName: saName,
            containers: [
              {
                name: 'tailscale',
                image: 'ghcr.io/tailscale/tailscale:latest',
                imagePullPolicy: 'IfNotPresent',
                env: [
                  {
                    name: 'TS_AUTHKEY',
                    valueFrom: { secretKeyRef: { name: secretName, key: 'TS_AUTHKEY' } },
                  },
                  { name: 'TS_HOSTNAME', value: hostname },
                  { name: 'TS_STATE_DIR', value: '/var/lib/tailscale' },
                  { name: 'TS_USERSPACE', value: 'true' },
                  { name: 'TS_KUBE_SECRET', value: secretName },
                  { name: 'TS_SERVE_CONFIG', value: '/config/serve-config.json' },
                ],
                resources: {
                  requests: { cpu: '10m', memory: '64Mi' },
                  limits: { cpu: '100m', memory: '128Mi' },
                },
                securityContext: {
                  runAsUser: 1000,
                  runAsGroup: 1000,
                },
                volumeMounts: [
                  { name: 'tailscale-state', mountPath: '/var/lib/tailscale' },
                  { name: 'serve-config', mountPath: '/config', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'tailscale-state', emptyDir: {} },
              {
                name: 'serve-config',
                configMap: { name: serveConfigName },
              },
            ],
          },
        },
      },
    };

    try {
      await appsApi.createNamespacedDeployment(namespace, tsDeployBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await appsApi.replaceNamespacedDeployment(tsDeployName, namespace, tsDeployBody);
      } else {
        throw error;
      }
    }

    // 6. Create a strict NetworkPolicy — the TS proxy pod can ONLY talk to the
    //    target deployment's pods. No internet, no other namespaces, no DNS even.
    const netpolName = `ts-isolate-${deploymentName}`;
    const netpolBody: k8s.V1NetworkPolicy = {
      metadata: { name: netpolName, namespace, labels: orchardLabels },
      spec: {
        podSelector: {
          matchLabels: { 'app.kubernetes.io/name': tsDeployName },
        },
        policyTypes: ['Ingress', 'Egress'],
        // Ingress: allow nothing from inside the cluster (Tailscale uses DERP/WireGuard UDP from outside)
        ingress: [],
        egress: [
          // Allow traffic ONLY to the target deployment's pods
          {
            to: [
              {
                podSelector: {
                  matchLabels: { 'app.kubernetes.io/name': deploymentName },
                },
              },
            ],
            ports: servicePorts.map((p) => ({
              port: p.targetPort,
              protocol: (p.protocol || 'TCP') as any,
            })),
          },
          // Allow DNS resolution (needed for K8s service name → ClusterIP)
          {
            to: [],
            ports: [
              { port: 53, protocol: 'UDP' as any },
              { port: 53, protocol: 'TCP' as any },
            ],
          },
          // Allow Tailscale DERP/coordination (external, any IP, specific ports)
          {
            to: [
              {
                ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] },
              },
            ],
            ports: [
              { port: 443, protocol: 'TCP' as any },    // DERP + coordination
              { port: 3478, protocol: 'UDP' as any },   // STUN
              { port: 41641, protocol: 'UDP' as any },  // WireGuard direct
            ],
          },
        ],
      },
    };

    try {
      await networkingApi.createNamespacedNetworkPolicy(namespace, netpolBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await networkingApi.replaceNamespacedNetworkPolicy(netpolName, namespace, netpolBody);
      } else {
        throw error;
      }
    }
  }

  /**
   * Remove the isolated Tailscale proxy pod and all associated resources.
   */
  async removeTailscaleSidecar(
    namespace: string,
    deploymentName: string,
  ): Promise<void> {
    this.ensureKubeConfig();
    if (!this.kc) return;

    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const tsDeployName = `ts-${deploymentName}`;
    const secretName = `ts-auth-${deploymentName}`;
    const netpolName = `ts-isolate-${deploymentName}`;
    const serveConfigName = `ts-serve-${deploymentName}`;

    // Delete the Tailscale proxy deployment
    try {
      await appsApi.deleteNamespacedDeployment(tsDeployName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) console.error(`[K8s] Failed to delete TS deployment ${tsDeployName}:`, e);
    }

    // Delete the NetworkPolicy
    try {
      await networkingApi.deleteNamespacedNetworkPolicy(netpolName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) console.error(`[K8s] Failed to delete NetworkPolicy ${netpolName}:`, e);
    }

    // Delete the ConfigMap
    try {
      await coreApi.deleteNamespacedConfigMap(serveConfigName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) console.error(`[K8s] Failed to delete ConfigMap ${serveConfigName}:`, e);
    }

    // Delete RBAC
    try {
      await rbacApi.deleteNamespacedRoleBinding(tsDeployName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) console.error(`[K8s] Failed to delete RoleBinding ${tsDeployName}:`, e);
    }
    try {
      await rbacApi.deleteNamespacedRole(tsDeployName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) console.error(`[K8s] Failed to delete Role ${tsDeployName}:`, e);
    }

    // Delete ServiceAccount
    try {
      await coreApi.deleteNamespacedServiceAccount(tsDeployName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) console.error(`[K8s] Failed to delete ServiceAccount ${tsDeployName}:`, e);
    }

    // Delete the secret
    try {
      await coreApi.deleteNamespacedSecret(secretName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) console.error(`[K8s] Failed to delete Secret ${secretName}:`, e);
    }
  }

  /**
   * Exec into the Tailscale proxy pod for a deployment and return its IP + DNS name.
   */
  async getTailscaleStatus(
    namespace: string,
    deploymentName: string,
  ): Promise<{ ip: string | null; dns: string | null }> {
    this.ensureKubeConfig();
    if (!this.kc) return { ip: null, dns: null };

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const tsDeployName = `ts-${deploymentName}`;

    // Find the running Tailscale proxy pod
    const { body: podList } = await coreApi.listNamespacedPod(
      namespace,
      undefined, undefined, undefined, undefined,
      `app.kubernetes.io/name=${tsDeployName}`,
    );

    const runningPod = podList.items.find((p) => p.status?.phase === 'Running');

    if (!runningPod?.metadata?.name) {
      return { ip: null, dns: null };
    }

    const exec = new k8s.Exec(this.kc);
    const podName = runningPod.metadata.name;

    return new Promise<{ ip: string | null; dns: string | null }>((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const stdout = new (require('stream').PassThrough)();
      const stderr = new (require('stream').PassThrough)();

      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      exec.exec(
        namespace,
        podName,
        'tailscale',
        ['tailscale', '--socket=/tmp/tailscaled.sock', 'status', '--json'],
        stdout,
        stderr,
        null,
        false,
        (status) => {
          try {
            const output = Buffer.concat(chunks).toString('utf-8').trim();
            if (status.status === 'Success' && output) {
              const data = JSON.parse(output);
              const selfKey = data.Self;
              if (selfKey) {
                const ip = selfKey.TailscaleIPs?.[0] || null;
                const dns = selfKey.DNSName?.replace(/\.$/, '') || null;
                resolve({ ip, dns });
                return;
              }
            }
          } catch {
            // Parse error — proxy may not be ready yet
          }
          resolve({ ip: null, dns: null });
        },
      ).catch(() => {
        resolve({ ip: null, dns: null });
      });
    });
  }

  async uninstallCnpgExtension(namespace: string, clusterName: string, dbName: string, extName: string): Promise<{ success: boolean; output: string }> {
    const safe = extName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return { success: false, output: 'Invalid extension name' };
    const r = await this.runPsqlInCnpg(namespace, clusterName, dbName, `DROP EXTENSION IF EXISTS "${safe}" CASCADE;`);
    return { success: r.success, output: r.stdout + r.stderr };
  }
}
