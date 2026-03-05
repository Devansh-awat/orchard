import { Injectable, ServiceUnavailableException, NotFoundException, BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  volumes?: {
    name: string;
    type: 'pvc' | 'hostPath' | 'emptyDir';
    mountPath: string;
    pvcName?: string;
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

      const deploymentBody: k8s.V1Deployment = {
        metadata: {
          name: cleanName,
          labels
        },
        spec: {
          replicas,
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

        annotations['traefik.ingress.kubernetes.io/router.middlewares'] =
          `${namespace}-${name}-auth@kubernetescrd`;
      } catch (error) {
        console.error('[K8s] Failed to create basic auth:', error);
      }
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const tlsHosts =
      options.tlsSecretName && options.tlsSecretName.trim().length > 0
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

    if (options.tlsSecretName && options.tlsSecretName.trim().length > 0) {
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

        annotations['traefik.ingress.kubernetes.io/router.middlewares'] =
          `${namespace}-${name}-auth@kubernetescrd`;
      } catch (error) {
        console.error('[K8s] Failed to create basic auth:', error);
      }
    } else if (options.basicAuth?.enabled === false) {
      try {
        const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
        await this.deleteBasicAuthSecret(namespace, basicAuthSecretName);
        await this.deleteBasicAuthMiddleware(namespace, name);
        delete annotations['traefik.ingress.kubernetes.io/router.middlewares'];
      } catch (error) {
        console.error('[K8s] Failed to remove basic auth:', error);
      }
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const tlsHosts =
      options.tlsSecretName && options.tlsSecretName.trim().length > 0
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

    if (options.tlsSecretName && options.tlsSecretName.trim().length > 0) {
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
      hostPath?: string | null;
      readOnly?: boolean;
    }[];
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

      const patch = {
        spec: {
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
        volumes: volumesList
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
        
        let status = 'pending';
        if (availableReplicas === replicas && replicas > 0) {
          status = 'running';
        } else if (availableReplicas > 0) {
          status = 'pending';
        } else {
          status = 'failed';
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
          status: { notIn: ['building'] }
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
}
