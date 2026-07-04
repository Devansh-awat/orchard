import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  KubernetesService,
  CreateDeploymentOptions,
  DeploymentPortInput,
  UpdateDeploymentEnvOptions, buildNodeAffinity
} from './kubernetes.service';
import { sanitizePortEntries, mapServicePorts } from './port-utils';
import { cpuMilliToK8s, memoryBytesToK8s } from './quantity';
import { isTrustedImage, trustedSecurityContext, hardenedSecurityContext } from './trusted-images';

/**
 * Workloads + pods + tailscale sidecar: Deployments and Pods CRUD, env/
 * health-check/volume updates, scale/restart, image bumps, pod logs/
 * events/metrics, deployment-pods aggregation, and the tailscale sidecar
 * patch flows.
 *
 * Shares kubeconfig + a few cross-domain helpers (createPVC, mapServicePorts,
 * getDefaultNodeIp) with the core KubernetesService via injection. Moved
 * bodies still use `this.kc`, `this.ensureKubeConfig()`, etc. — delegated
 * below so the bodies stay byte-identical.
 */
const POD_BACKOFF_REASONS = new Set([
  'crashloopbackoff',
  'imagepullbackoff',
  'errimagepull',
  'errimagepullbackoff',
  'createcontainererror',
  'createcontainerconfigerror',
  'runcontainererror',
  'invalidimagename',
]);

function podBackoffReason(containerStatuses: any[] | undefined): string | null {
  for (const c of containerStatuses ?? []) {
    const reason = c?.state?.waiting?.reason;
    if (reason && POD_BACKOFF_REASONS.has(String(reason).toLowerCase())) {
      return reason;
    }
  }
  return null;
}

@Injectable()
export class K8sWorkloadService {
  private readonly logger = new Logger(K8sWorkloadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
  ) {}

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  private ensureKubeConfig() {
    this.kubernetes.ensureKubeConfig();
  }

  private getDefaultNodeIp(coreApi: k8s.CoreV1Api) {
    return this.kubernetes.getDefaultNodeIp(coreApi);
  }

  private createPVC(namespace: string, name: string, storageSize = '1Gi') {
    return this.kubernetes.createPVC(namespace, name, storageSize);
  }

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

  async listPods(namespace = 'midnight-staging') {
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

  async getKubernetesDeployment(deploymentName: string, namespace = 'midnight-staging') {
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

  async getPod(podName: string, namespace = 'midnight-staging') {
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

  async deletePod(podName: string, namespace = 'midnight-staging') {
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

  async getPodLogs(podName: string, namespace = 'midnight-staging', containerName?: string, tailLines = 100, previous = false) {
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
          previous,
          undefined,
          tailLines,
          true
        );

        return {
          podName: cleanPodName,
          container: targetContainer,
          namespace: cleanNamespace,
          logs: logs.body,
          tailLines,
          previous,
        };
      } catch (logError) {
        const statusCode = logError.response?.statusCode;
        const k8sMessage: string = logError.response?.body?.message || '';

        // k8s answers 400 "container ... is waiting to start: ContainerCreating"
        // (or PodInitializing / image pull states) for pods that haven't started
        // yet — routine right after a scale-up or restart while the frontend is
        // already polling logs. Not an error: report empty logs until the
        // container is up.
        if (statusCode === 400 && k8sMessage.includes('is waiting to start')) {
          return {
            podName: cleanPodName,
            container: targetContainer,
            namespace: cleanNamespace,
            logs: '',
            tailLines,
            pending: true,
            message: k8sMessage
          };
        }

        if (statusCode === 400 && previous && /previous terminated container/i.test(k8sMessage)) {
          return {
            podName: cleanPodName,
            container: targetContainer,
            namespace: cleanNamespace,
            logs: '',
            tailLines,
            previous: true,
            noPreviousLogs: true,
            message: k8sMessage
          };
        }

        if (statusCode !== 404) {
          console.error('[API] Log fetch error details:', {
            message: logError.message,
            code: logError.code,
            statusCode,
            body: logError.response?.body
          });
        }

        throw new BadRequestException({
          error: 'Failed to fetch logs',
          message: logError.response?.body?.message || logError.message || 'Error occurred in log request',
          availableContainers: containers,
          targetContainer,
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

  async listDeployments(namespace = 'midnight-staging') {
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
    let sanitizedPorts = sanitizePortEntries(Array.isArray(options.ports) ? options.ports : []);

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

    let requestedServiceType: 'LoadBalancer' | 'NodePort' | 'ClusterIP' = 'ClusterIP';
    if (options.serviceType === 'LoadBalancer') requestedServiceType = 'LoadBalancer';
    else if (options.serviceType === 'NodePort') requestedServiceType = 'NodePort';

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

        if (vol.type === 'hostPath') {
          // hostPath mounts trivially escape tenant isolation by exposing the
          // node filesystem (docker.sock, kubelet creds, /etc/kubernetes). Hard
          // refuse at the lowest layer, regardless of caller role.
          throw new Error('hostPath volumes are not permitted');
        }

        if (vol.type === 'pvc' && vol.pvcName) {
          volume.persistentVolumeClaim = {
            claimName: vol.pvcName,
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
        // Defence-in-depth even when the pod runs under gVisor (runsc):
        // drop every Linux capability except the minimal entrypoint
        // uid-drop set (see trusted-images.ts), refuse setuid privilege
        // escalation mid-process, and apply the runtime's default seccomp
        // profile.
        // We deliberately do NOT force runAsNonRoot — many tenant images
        // still chown/listen on :80 as root and would crashloop. gVisor
        // already neuters root-in-container by virtualising the kernel,
        // so this is acceptable.
        //
        // Trusted images keep the default container caps so their
        // entrypoints can perform a root→service-user drop (Redis, etc).
        securityContext: isTrustedImage(cleanImage)
          ? trustedSecurityContext()
          : hardenedSecurityContext(),
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
        : { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };

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
              // Tenant pods do not need to talk to the kube-apiserver. The
              // default ServiceAccount token, if mounted, lets a compromised
              // pod do `selfsubjectreviews` and (more importantly) carries
              // any unintended RBAC grants out of the namespace.
              automountServiceAccountToken: false,
              // Run under gVisor (runsc) when configured — a user-space
              // kernel that intercepts syscalls. A kernel CVE in the
              // tenant's image no longer reaches the host kernel; a
              // container escape requires escaping runsc itself.
              // Falsy env var ⇒ undefined ⇒ default containerd handler.
              // Trusted first-party images (see trusted-images.ts) skip
              // the sandbox — runsc rejects some uid/cap transitions that
              // their entrypoints rely on (e.g. Redis's root→redis drop).
              runtimeClassName: isTrustedImage(cleanImage)
                ? undefined
                : (process.env.TENANT_RUNTIME_CLASS || undefined),
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
          const mappedPorts = mapServicePorts(fetchedService.body.spec?.ports, sanitizedPorts);
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

      if (vol.type === 'hostPath') {
        throw new Error('hostPath volumes are not permitted');
      }

      if (vol.type === 'pvc' && vol.pvcName) {
        volume.persistentVolumeClaim = {
          claimName: vol.pvcName,
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
        : { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };

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


  async deleteDeployment(deploymentName: string, namespace = 'midnight-staging') {
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

          const sanitizedServicePorts = sanitizePortEntries(rawPorts);

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
          buildStatus: 'succeeded',
        }
      });

      for (const dbDeployment of dbDeployments) {
        if (!dbDeploymentNames.has(dbDeployment.name)) {
          this.logger.warn(
            `[Sync] ${namespace}: deployment "${dbDeployment.name}" (${dbDeployment.id}) built successfully but is absent from k8s; removing stale DB row`,
          );
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


  async restartDeployment(deploymentName: string, namespace = 'midnight-staging') {
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

  async waitForReady(
    deploymentName: string,
    namespace: string,
    timeoutMs = 120_000,
    pollMs = 2_000,
  ): Promise<boolean> {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await api.readNamespacedDeployment(deploymentName, namespace);
        const status = res.body.status;
        const spec = res.body.spec;
        if (
          status?.updatedReplicas === spec?.replicas &&
          status?.readyReplicas === spec?.replicas &&
          (status?.unavailableReplicas ?? 0) === 0
        ) {
          return true;
        }
      } catch {}
      await new Promise((r) => { setTimeout(r, pollMs); });
    }
    return false;
  }

  async patchDeploymentReplicas(deploymentName: string, namespace: string, replicas: number) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    await api.patchNamespacedDeployment(
      deploymentName, namespace,
      { spec: { replicas } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
    );
  }

  async scaleDeployment(deploymentName: string, namespace: string, replicas: number) {
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
          replicas
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
            replicas
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
      : { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };

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
          if (cpuStr.endsWith('n')) cpu += parseInt(cpuStr, 10) / 1_000_000;
          else if (cpuStr.endsWith('u')) cpu += parseInt(cpuStr, 10) / 1000;
          else if (cpuStr.endsWith('m')) cpu += parseInt(cpuStr, 10);
          else cpu += parseFloat(cpuStr) * 1000;
          if (memStr.endsWith('Ki')) mem += parseInt(memStr, 10) * 1024;
          else if (memStr.endsWith('Mi')) mem += parseInt(memStr, 10) * 1024 * 1024;
          else if (memStr.endsWith('Gi')) mem += parseInt(memStr, 10) * 1024 * 1024 * 1024;
          else mem += parseInt(memStr, 10);
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
            totalCpu += parseInt(cpuStr, 10) / 1_000_000; // nanocores to millicores
          } else if (cpuStr.endsWith('m')) {
            totalCpu += parseInt(cpuStr, 10);
          } else {
            totalCpu += parseFloat(cpuStr) * 1000; // cores to millicores
          }

          // Parse memory: could be "123Ki", "456Mi", "789Gi", or plain bytes
          if (memStr.endsWith('Ki')) {
            totalMemory += parseInt(memStr, 10) * 1024;
          } else if (memStr.endsWith('Mi')) {
            totalMemory += parseInt(memStr, 10) * 1024 * 1024;
          } else if (memStr.endsWith('Gi')) {
            totalMemory += parseInt(memStr, 10) * 1024 * 1024 * 1024;
          } else {
            totalMemory += parseInt(memStr, 10);
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
          if (isReady && allContainersReady) computedStatus = 'ready';
          else if (isScheduled) computedStatus = 'scheduled';
          else computedStatus = 'pending';
        } else if (podPhase === 'pending' && isScheduled) {
          computedStatus = 'scheduled';
        }
        if (podBackoffReason(containerStatuses)) {
          computedStatus = 'crashing';
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

  async getDeploymentPods(deploymentName: string, namespace = 'midnight-staging') {
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

          const term = state?.terminated ?? status?.lastState?.terminated;

          return {
            name: container.name,
            image: container.image,
            ready: status?.ready ?? false,
            restartCount: status?.restartCount ?? 0,
            warning: containerWarning,
            lastTerminatedAt: term?.finishedAt,
            lastTerminationReason: term?.reason,
            lastExitCode: term?.exitCode,
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
        if (podBackoffReason(containerStatuses)) {
          computedStatus = 'crashing';
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

      // Warnings mirror the pod's CURRENT state, not k8s event history.
      // Kubernetes retains warning events for ~1h after the condition
      // resolves, so a pod that briefly failed scheduling or volume attach
      // would otherwise keep showing the alert long after it went ready.
      const RECENT_TERMINATION_MS = 15 * 60 * 1000;
      const warnings = pods.flatMap(pod => {
        const podWarnings: { message: string; timestamp?: any }[] = [];

        pod.containers?.forEach(container => {
          if (container.warning) {
            podWarnings.push({ message: `${container.name}: ${container.warning}` });
          }
          const terminatedAt = container.lastTerminatedAt
            ? new Date(container.lastTerminatedAt).getTime()
            : null;
          const recentlyTerminated =
            terminatedAt !== null && Date.now() - terminatedAt < RECENT_TERMINATION_MS;
          const restartingOrRecentlyDied =
            container.restartCount > 0 && (pod.status !== 'ready' || recentlyTerminated);

          const reason = container.lastTerminationReason;
          if (
            reason &&
            reason !== 'Completed' &&
            reason !== 'Error' &&
            restartingOrRecentlyDied
          ) {
            const codePart =
              container.lastExitCode != null ? ` (exit code ${container.lastExitCode})` : '';
            podWarnings.push({
              message: `${container.name}: last terminated with ${reason}${codePart}`,
              timestamp: container.lastTerminatedAt,
            });
          }

          if (restartingOrRecentlyDied) {
            podWarnings.push({
              message: `${container.name} has restarted ${container.restartCount} time(s)`,
              timestamp: container.lastTerminatedAt,
            });
          }
        });

        if (pod.status !== 'ready') {
          pod.events?.forEach(event => {
            if (/failedscheduling/i.test(event.reason ?? '') && pod.nodeName) return;
            podWarnings.push({
              message: `${event.reason}: ${event.message}`,
              timestamp: event.lastTimestamp,
            });
          });
        }

        return podWarnings.map(warning => ({
          podName: pod.name,
          message: warning.message,
          timestamp: warning.timestamp || pod.createdAt,
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

  /**
   * Lightweight batch: one listNamespacedPod call per namespace, bucketed by
   * the `app.kubernetes.io/name` label (which every orchard-managed Deployment
   * sets via selectorLabels). Returns just enough shape for
   * computeDeploymentStatus — pod phase/ready/restarts and a crash-loop flag —
   * skipping the per-pod events + metrics fetches that getDeploymentPods does.
   *
   * Use for list/overview endpoints where you have many deployments in a
   * shared namespace; collapses 2*N round-trips to a single one.
   */
  async listPodStatusesByDeploymentInNamespace(namespace: string): Promise<
    Map<string, { pods: { status: string; restartCount: number }[]; warnings: { message: string }[] }>
  > {
    this.ensureKubeConfig();
    const cleanNamespace = String(namespace || '').trim();
    if (!cleanNamespace) return new Map();

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const result = new Map<
      string,
      { pods: { status: string; restartCount: number }[]; warnings: { message: string }[] }
    >();

    try {
      const podList = await coreApi.listNamespacedPod(
        cleanNamespace,
        undefined, undefined, undefined, undefined,
        'app.kubernetes.io/managed-by=orchard',
      );

      for (const pod of podList.body.items) {
        const deploymentName = pod.metadata?.labels?.['app.kubernetes.io/name'];
        if (!deploymentName) continue;

        const containerStatuses = pod.status?.containerStatuses ?? [];
        const phase = pod.status?.phase?.toLowerCase() ?? 'pending';
        const conditions = pod.status?.conditions ?? [];
        const isReady = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
        const allContainersReady =
          containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);

        let computedStatus = phase;
        if (phase === 'running') {
          computedStatus = isReady && allContainersReady ? 'ready' : 'pending';
        }
        if (podBackoffReason(containerStatuses)) {
          computedStatus = 'crashing';
        }

        const totalRestarts = containerStatuses.reduce(
          (sum, c) => sum + (c.restartCount ?? 0),
          0,
        );

        const bucket = result.get(deploymentName) ?? { pods: [], warnings: [] };
        bucket.pods.push({ status: computedStatus, restartCount: totalRestarts });

        for (const cs of containerStatuses) {
          const reason = cs.state?.waiting?.reason;
          if (reason === 'CrashLoopBackOff' || reason === 'ImagePullBackOff') {
            bucket.warnings.push({
              message: cs.state?.waiting?.message ?? reason,
            });
          }
        }

        result.set(deploymentName, bucket);
      }
    } catch (err: any) {
      // 404 just means the namespace doesn't exist yet; treat as empty.
      if (err?.response?.statusCode !== 404) {
        console.error(`[API] listPodStatusesByDeploymentInNamespace(${cleanNamespace}):`, err?.message ?? err);
      }
    }

    return result;
  }


  // ── Public (MetalLB LoadBalancer) exposure ──

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

      const stdout = new PassThrough();
      const stderr = new PassThrough();

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

}
