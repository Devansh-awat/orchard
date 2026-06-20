import { Injectable, ServiceUnavailableException, NotFoundException, BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseCpu, parseMemory } from './quantity';
import { isTrustedImage, trustedSecurityContext, hardenedSecurityContext } from './trusted-images';
import { sanitizePortEntries } from './port-utils';

export const ALLOWED_INGRESS_ANNOTATION_KEYS = new Set<string>([
  'cert-manager.io/cluster-issuer',
  'cert-manager.io/issuer',
  'ingress.cilium.io/force-https',
  'orchard.my/basic-auth',
]);

export function buildNodeAffinity(
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

export type DeploymentEnvVarInput = {
  key: string;
  value: string;
};

export type DeploymentPortInput = {
  name?: string;
  containerPort?: number;
  servicePort?: number;
  protocol?: string;
  nodePort?: number;
};

export type SanitizedPortEntry = {
  name: string;
  containerPort: number;
  servicePort: number;
  protocol: string;
  nodePort?: number;
};

export type CreateDeploymentOptions = {
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

export type UpdateDeploymentEnvOptions = {
  namespace: string;
  deploymentName: string;
  env: DeploymentEnvVarInput[];
};

export type UpdateServiceExposureOptions = {
  namespace: string;
  serviceName: string;
  type: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
};

export type UpdateServicePortsOptions = {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  ports: DeploymentPortInput[];
};

export type CreateAdditionalServiceOptions = {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  ports: DeploymentPortInput[];
  type?: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
};

export type DeleteDeploymentServiceOptions = {
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

export type CreateIngressOptions = {
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
  kc: k8s.KubeConfig | null;

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

  ensureKubeConfig() {
    if (!this.kc) {
      throw new ServiceUnavailableException({
        error: 'Kubernetes API not available',
        message: 'Kubeconfig could not be loaded. Check server logs for details.'
      });
    }
  }

  // Exposed for sibling services (e.g. R2ProxyService) that need raw kube
  // client access without duplicating the kubeconfig-loading logic above.
  public getCoreV1Api(): k8s.CoreV1Api {
    this.ensureKubeConfig();
    return this.kc!.makeApiClient(k8s.CoreV1Api);
  }

  async getDefaultNodeIp(coreApi: k8s.CoreV1Api): Promise<string | null> {
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

}
