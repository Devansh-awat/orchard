import { z } from 'zod';
import type { RouteAttachment } from '../types';

// BigInt columns (memoryRequestBytes, githubInstallationId, githubDeploymentId)
// serialize as strings on the wire.
const bigIntString = z.union([z.string(), z.number()]);

const envVarInput = z.object({
  key: z.string(),
  value: z.string(),
  secret: z.boolean().optional(),
});

const portInput = z.object({
  name: z.string().optional(),
  containerPort: z.number().int().optional(),
  servicePort: z.number().int().optional(),
  protocol: z.string().optional(),
  nodePort: z.number().int().optional(),
});

const volumeInput = z.object({
  name: z.string(),
  type: z.enum(['pvc', 'hostPath', 'emptyDir']),
  mountPath: z.string(),
  pvcName: z.string().optional(),
  storageSize: z.string().optional(),
  hostPath: z.string().optional(),
  readOnly: z.boolean().optional(),
});

const ingressRouteInput = z.object({
  path: z.string(),
  serviceName: z.string(),
  servicePort: z.number().int(),
});

const basicAuthInput = z.object({
  enabled: z.boolean(),
  username: z.string().optional(),
  password: z.string().optional(),
});

const envVarRecord = z
  .object({
    id: z.string(),
    deploymentId: z.string(),
    key: z.string(),
    value: z.string().nullable(),
    secret: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const servicePortRecord = z
  .object({
    id: z.string(),
    serviceId: z.string(),
    name: z.string().nullable().optional(),
    port: z.number(),
    targetPort: z.number(),
    protocol: z.string(),
    nodePort: z.number().nullable().optional(),
    publicEnabled: z.boolean().optional(),
    publicPort: z.number().nullable().optional(),
  })
  .passthrough();

const serviceRecord = z
  .object({
    id: z.string(),
    deploymentId: z.string(),
    name: z.string(),
    type: z.enum(['internal', 'external', 'ingress']),
    port: z.number(),
    targetPort: z.number(),
    protocol: z.string(),
    externalIp: z.string().nullable().optional(),
    nodePort: z.number().nullable().optional(),
    domain: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    ports: z.array(servicePortRecord).optional(),
    internalUrl: z.string().optional(),
    internalUrls: z.array(z.string()).optional(),
  })
  .passthrough();

const ingressRouteRecord = z
  .object({
    path: z.string(),
    serviceName: z.string(),
    servicePort: z.number(),
  })
  .passthrough();

const ingressRecord = z
  .object({
    id: z.string(),
    projectId: z.string().optional(),
    deploymentId: z.string().nullable().optional(),
    serviceId: z.string().nullable().optional(),
    name: z.string(),
    namespace: z.string().optional(),
    host: z.string(),
    path: z.string(),
    pathType: z.string().optional(),
    tlsSecretName: z.string().nullable().optional(),
    tlsHosts: z.array(z.string()).optional(),
    ingressClass: z.string().nullable().optional(),
    entrypoints: z.array(z.string()).optional(),
    clusterIssuer: z.string().nullable().optional(),
    annotations: z.record(z.any()).nullable().optional(),
    statusAddress: z.string().nullable().optional(),
    protectionMode: z.enum(['none', 'password', 'orchard']).optional(),
    protectionBypassSecret: z.string().nullable().optional(),
    templateInstanceId: z.string().nullable().optional(),
    environmentId: z.string().nullable().optional(),
    routes: z.array(ingressRouteRecord).optional(),
    service: serviceRecord.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const volumeRecord = z
  .object({
    id: z.string(),
    deploymentId: z.string().optional(),
    name: z.string(),
    type: z.enum(['pvc', 'hostPath', 'emptyDir']),
    mountPath: z.string(),
    pvcName: z.string().nullable().optional(),
    storageSize: z.string().nullable().optional(),
    hostPath: z.string().nullable().optional(),
    readOnly: z.boolean(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const podRecord = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    status: z.string(),
    ip: z.string().nullable().optional(),
    podIp: z.string().nullable().optional(),
    nodeName: z.string().nullable().optional(),
    restartCount: z.number().optional(),
    startTime: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    cpuUsage: z.number().nullable().optional(),
    memoryUsage: z.number().nullable().optional(),
    containers: z
      .array(
        z
          .object({
            name: z.string(),
            image: z.string().optional(),
            ready: z.boolean().optional(),
            restartCount: z.number().optional(),
            lastTermination: z
              .object({
                reason: z.string(),
                exitCode: z.number().nullable().optional(),
                finishedAt: z.string().nullable().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const podWarning = z
  .object({
    podName: z.string().optional(),
    message: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const userRef = z
  .object({
    id: z.string(),
    username: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
  })
  .passthrough();

const imageHistoryRecord = z
  .object({
    id: z.string(),
    deploymentId: z.string().optional(),
    image: z.string(),
    tag: z.string().optional(),
    commitSha: z.string().nullable().optional(),
    commitMessage: z.string().nullable().optional(),
    commitAuthorName: z.string().nullable().optional(),
    commitAuthorUsername: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    buildLogs: z.string().nullable().optional(),
    buildStartedAt: z.string().nullable().optional(),
    buildCompletedAt: z.string().nullable().optional(),
    triggerType: z.string().nullable().optional(),
    triggeredById: z.string().nullable().optional(),
    triggeredBy: userRef.nullable().optional(),
    isActive: z.boolean(),
    createdAt: z.string(),
  })
  .passthrough();

const projectRef = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().optional(),
    organizationId: z.string().optional(),
  })
  .passthrough();

const deploymentBase = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    namespace: z.string(),
    image: z.string().nullable().optional(),
    replicas: z.number(),
    cpuRequestMilli: z.number().nullable().optional(),
    // BigInt column, serializes as a string
    memoryRequestBytes: bigIntString.nullable().optional(),
    status: z.string(),
    buildStatus: z.string(),
    buildStep: z.string().nullable().optional(),
    buildType: z.enum(['dockerfile', 'railpack']).optional(),
    deployStrategy: z.enum(['rollingUpdate', 'recreate']).optional(),
    imagePullPolicy: z
      .enum(['Always', 'IfNotPresent'])
      .nullish()
      .describe('The override. null means it is derived from the image tag.'),
    effectiveImagePullPolicy: z
      .enum(['Always', 'IfNotPresent'])
      .optional()
      .describe('What the cluster is actually doing, after deriving. Render this.'),
    githubRepo: z.string().nullable().optional(),
    githubBranch: z.string().nullable().optional(),
    dockerfilePath: z.string().nullable().optional(),
    buildFromRoot: z.boolean().optional(),
    buildWithDepot: z.boolean().optional(),
    persistentBuildCache: z.boolean().optional(),
    // Zero-config build settings. Null means "use whatever Railpack detected".
    rootDirectory: z.string().nullable().optional(),
    framework: z.string().nullable().optional(),
    installCommand: z.string().nullable().optional(),
    buildCommand: z.string().nullable().optional(),
    startCommand: z.string().nullable().optional(),
    outputDirectory: z.string().nullable().optional(),
    detectedConfig: z.record(z.any()).nullable().optional(),
    buildLogs: z.string().nullable().optional(),
    buildError: z.string().nullable().optional(),
    buildStepTimestamps: z.record(z.any()).nullable().optional(),
    createdBy: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    tailscaleExposed: z.boolean().optional(),
    tailscaleHostname: z.string().nullable().optional(),
    autoDeployEnabled: z.boolean().optional(),
    autoDeployBranch: z.string().nullable().optional(),
    // BigInt column, serializes as a string
    githubInstallationId: bigIntString.nullable().optional(),
    healthCheckEnabled: z.boolean().optional(),
    healthCheckPath: z.string().nullable().optional(),
    healthCheckPort: z.number().nullable().optional(),
    healthCheckType: z.string().optional(),
    healthCheckCommand: z.string().nullable().optional(),
    livenessEnabled: z.boolean().optional(),
    readinessEnabled: z.boolean().optional(),
    startupEnabled: z.boolean().optional(),
    healthCheckInterval: z.number().optional(),
    healthCheckTimeout: z.number().optional(),
    healthCheckRetries: z.number().optional(),
    startupFailureThreshold: z.number().optional(),
    templateInstanceId: z.string().nullable().optional(),
    composeStackId: z.string().nullable().optional(),
    composeServiceName: z.string().nullable().optional(),
    environmentId: z.string().nullable().optional(),
  })
  .passthrough();

const deploymentWithRelations = deploymentBase.extend({
  pods: z.array(podRecord).optional(),
  services: z.array(serviceRecord).optional(),
  envVars: z.array(envVarRecord).optional(),
  volumes: z.array(volumeRecord).optional(),
  ingresses: z.array(ingressRecord).optional(),
  project: projectRef.optional(),
  warnings: z.array(podWarning).optional(),
});

const deploymentDetail = deploymentWithRelations.extend({
  availableReplicas: z.number(),
  warnings: z.array(podWarning),
  totalCpuUsage: z.number().nullable(),
  totalMemoryUsage: z.number().nullable(),
  imageHistory: z.array(imageHistoryRecord).optional(),
  environment: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      isDefault: z.boolean(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

const deploymentSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    buildStatus: z.string(),
    image: z.string().nullable().optional(),
    githubRepo: z.string().nullable().optional(),
    githubBranch: z.string().nullable().optional(),
    updatedAt: z.string(),
    replicas: z.number(),
    ingresses: z.array(z.object({ id: z.string(), host: z.string() }).passthrough()),
    project: projectRef,
  })
  .passthrough();

const seriesPoint = z.object({ x: z.number(), y: z.number() }).passthrough();

const metricsResponse = z
  .object({
    start: z.number(),
    end: z.number(),
    step: z.number(),
    data: z
      .object({
        cpu: z.array(seriesPoint),
        mem: z.array(seriesPoint),
        rx: z.array(seriesPoint),
        tx: z.array(seriesPoint),
      })
      .passthrough(),
  })
  .passthrough();

const killedContainerMeta = z
  .object({
    entryId: z.string(),
    pod: z.string(),
    container: z.string(),
    reason: z.string(),
    exitCode: z.number().nullable(),
    finishedAt: z.string().nullable(),
    capturedAt: z.string(),
  })
  .passthrough();

const githubDeploymentRecord = z
  .object({
    id: z.string(),
    deploymentId: z.string(),
    // BigInt column, serializes as a string
    githubDeploymentId: bigIntString,
    owner: z.string(),
    repo: z.string(),
    ref: z.string(),
    commitSha: z.string(),
    environment: z.string(),
    status: z.string(),
    logUrl: z.string().nullable().optional(),
    environmentUrl: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const protectionResponse = z
  .object({
    protectionMode: z.enum(['none', 'password', 'orchard']),
    protectionBypassSecret: z.string().nullable(),
  })
  .passthrough();

const deploymentIngressRequest = z.object({
  host: z.string(),
  path: z.string().optional(),
  serviceName: z.string().optional(),
  servicePort: z.number().int().optional(),
  tlsEnabled: z.boolean().optional(),
  annotations: z.record(z.string()).optional(),
  routes: z.array(ingressRouteInput).optional(),
  basicAuth: basicAuthInput.optional(),
});

const projectIngressRequest = z.object({
  host: z.string(),
  tlsEnabled: z.boolean().optional(),
  routes: z.array(ingressRouteInput),
  basicAuth: basicAuthInput.optional(),
});

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /deployments': {
    summary: 'List deployments visible to the caller (summary shape)',
    scope: 'read',
    request: z.object({ orgId: z.string().optional() }),
    response: z.array(deploymentSummary),
  },
  'GET /deployments/recent-builds': {
    summary: 'List active and recently completed builds',
    scope: 'read',
    request: z.object({ orgId: z.string().optional() }),
    response: z
      .object({
        active: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              image: z.string().nullable().optional(),
              status: z.string(),
              buildStatus: z.string(),
              buildStep: z.string().nullable().optional(),
              updatedAt: z.string(),
              githubRepo: z.string().nullable().optional(),
              githubBranch: z.string().nullable().optional(),
              ingresses: z.array(z.object({ host: z.string() }).passthrough()),
              project: z.object({ name: z.string() }).passthrough(),
            })
            .passthrough(),
        ),
        recent: z.array(
          z
            .object({
              id: z.string(),
              commitSha: z.string().nullable().optional(),
              branch: z.string().nullable().optional(),
              triggerType: z.string().nullable().optional(),
              isActive: z.boolean(),
              createdAt: z.string(),
              deployment: z
                .object({
                  id: z.string(),
                  name: z.string(),
                  image: z.string().nullable().optional(),
                  buildStatus: z.string(),
                  ingresses: z.array(z.object({ host: z.string() }).passthrough()),
                  project: z.object({ name: z.string() }).passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  },
  'GET /deployments/:id': {
    summary: 'Get a deployment with live pods, services, ingresses, and image history',
    scope: 'read',
    response: deploymentDetail,
  },
  'DELETE /deployments/:id': {
    summary: 'Delete a deployment and all its Kubernetes resources',
    scope: 'deploy',
    response: z
      .object({ success: z.boolean(), deploymentId: z.string(), projectId: z.string() })
      .passthrough(),
  },
  'GET /projects/:id/deployments': {
    summary: 'List deployments in a project with live pod state',
    scope: 'read',
    response: z.array(deploymentWithRelations),
  },
  'POST /projects/:id/deployments': {
    summary: 'Create a deployment from a Docker image',
    scope: 'deploy',
    request: z.object({
      name: z.string(),
      image: z.string(),
      port: z.number().int().optional(),
      ports: z.array(portInput).optional(),
      replicas: z.number().int().optional(),
      env: z.array(envVarInput).optional(),
      exposePublic: z.boolean().optional(),
      volumes: z.array(volumeInput).optional(),
      cpuRequestMilli: z.number().int().nullable().optional(),
      memoryRequestBytes: z.number().int().nullable().optional(),
      imagePullPolicy: z
        .enum(['Always', 'IfNotPresent'])
        .nullish()
        .describe(
          'Omit to derive it from the tag, which already gives a moving tag like :latest the Always behaviour. Pass a value only to pin it.',
        ),
    }),
    response: deploymentWithRelations,
  },
  'POST /projects/:id/deployments/from-github': {
    summary: 'Create a deployment built from a GitHub repository',
    scope: 'deploy',
    request: z.object({
      name: z.string(),
      repoUrl: z.string().optional(),
      githubRepo: z.string().optional(),
      branch: z.string().optional(),
      dockerfilePath: z.string().optional(),
      target: z.string().optional(),
      tag: z.string().optional(),
      buildFromRoot: z.boolean().optional(),
      buildWithDepot: z.boolean().optional(),
      buildType: z.enum(['dockerfile', 'railpack']).optional(),
      // Zero-config build settings; omit to use Railpack's own detection.
      rootDirectory: z.string().nullable().optional(),
      framework: z.string().nullable().optional(),
      installCommand: z.string().nullable().optional(),
      buildCommand: z.string().nullable().optional(),
      startCommand: z.string().nullable().optional(),
      outputDirectory: z.string().nullable().optional(),
      port: z.number().int().optional(),
      ports: z.array(portInput).optional(),
      replicas: z.number().int().optional(),
      env: z.array(envVarInput).optional(),
      exposePublic: z.boolean().optional(),
      volumes: z.array(volumeInput).optional(),
      cpuRequestMilli: z.number().int().nullable().optional(),
      memoryRequestBytes: z.number().int().nullable().optional(),
    }),
    response: deploymentWithRelations,
  },
  'PUT /deployments/:id/env': {
    summary: 'Replace the environment variables of a deployment',
    scope: 'deploy',
    request: z.object({ env: z.array(envVarInput) }),
    response: deploymentWithRelations,
  },
  'PATCH /deployments/:id/resources': {
    summary: 'Update per-pod CPU and memory requests',
    scope: 'deploy',
    request: z.object({
      cpuRequestMilli: z.number().int().nullable().optional(),
      memoryRequestBytes: z.number().int().nullable().optional(),
    }),
    response: deploymentBase,
  },
  'PATCH /deployments/:id/image': {
    summary: 'Change the container image of an image-based deployment',
    scope: 'deploy',
    request: z.object({ image: z.string() }),
    response: deploymentBase,
  },
  'PATCH /deployments/:id/strategy': {
    summary: 'Change the deploy strategy',
    scope: 'deploy',
    request: z.object({ strategy: z.enum(['rollingUpdate', 'recreate']) }),
    response: deploymentBase,
  },
  'GET /deployments/:id/next-steps': {
    summary: 'What is still worth configuring on this deployment',
    scope: 'read',
    response: z.object({
      steps: z.array(
        z.object({
          id: z.string(),
          applicable: z
            .boolean()
            .describe('False when the step cannot apply here, e.g. auto-deploy on a non-GitHub app.'),
          done: z.boolean(),
        }),
      ),
    }),
  },
  'PATCH /deployments/:id/pull-policy': {
    summary: 'Pin or clear the image pull policy override',
    scope: 'deploy',
    request: z.object({
      imagePullPolicy: z
        .enum(['Always', 'IfNotPresent'])
        .nullable()
        .describe(
          'Pin the policy, or null to go back to deriving it from the image tag. A pinned value survives an image change.',
        ),
    }),
    response: deploymentBase,
  },
  'PUT /deployments/:id/volumes': {
    summary: 'Replace the volumes of a deployment',
    scope: 'deploy',
    request: z.object({ volumes: z.array(volumeInput) }),
    response: deploymentWithRelations,
  },
  'PUT /deployments/:id/health-check': {
    summary: 'Update health check configuration',
    scope: 'deploy',
    request: z.object({
      healthCheckEnabled: z.boolean(),
      healthCheckType: z.string(),
      healthCheckPath: z.string().optional(),
      healthCheckPort: z.number().int().optional(),
      healthCheckCommand: z.string().optional(),
      livenessEnabled: z.boolean(),
      readinessEnabled: z.boolean(),
      startupEnabled: z.boolean(),
      healthCheckInterval: z.number().int(),
      healthCheckTimeout: z.number().int(),
      healthCheckRetries: z.number().int(),
      startupFailureThreshold: z.number().int(),
    }),
    response: deploymentDetail,
  },
  'PUT /deployments/:id/build-config': {
    summary: 'Update build settings',
    scope: 'deploy',
    request: z.object({
      buildFromRoot: z.boolean().optional(),
      buildWithDepot: z.boolean().optional(),
      persistentBuildCache: z.boolean().optional(),
      buildType: z.enum(['dockerfile', 'railpack']).optional(),
      // Pass null to clear an override and fall back to Railpack's detection.
      rootDirectory: z.string().nullable().optional(),
      framework: z.string().nullable().optional(),
      installCommand: z.string().nullable().optional(),
      buildCommand: z.string().nullable().optional(),
      startCommand: z.string().nullable().optional(),
      outputDirectory: z.string().nullable().optional(),
    }),
    response: deploymentDetail,
  },
  'POST /deployments/:id/scale': {
    summary: 'Scale a deployment to a replica count',
    scope: 'deploy',
    request: z.object({ replicas: z.number().int() }),
    response: z
      .object({
        success: z.boolean(),
        deploymentId: z.string(),
        projectId: z.string(),
        replicas: z.number(),
      })
      .passthrough(),
  },
  'POST /deployments/:id/restart': {
    summary: 'Rolling-restart all pods of a deployment',
    scope: 'deploy',
    response: z
      .object({
        success: z.boolean(),
        deployment: z.string(),
        namespace: z.string(),
        restartedAt: z.string(),
      })
      .passthrough(),
  },
  'POST /deployments/:id/rebuild': {
    summary: 'Trigger a rebuild from the linked GitHub repository',
    scope: 'deploy',
    response: deploymentWithRelations,
  },
  'POST /deployments/:id/cancel': {
    summary: 'Cancel an in-progress build',
    scope: 'deploy',
    response: z
      .object({ success: z.boolean(), deploymentId: z.string(), message: z.string() })
      .passthrough(),
  },
  'POST /deployments/:id/rollback/:imageHistoryId': {
    summary: 'Roll back to a previous image',
    scope: 'deploy',
    response: deploymentWithRelations,
  },
  'GET /deployments/:id/pods': {
    summary: 'List the pods of a deployment',
    scope: 'read',
    response: z.array(podRecord),
  },
  'GET /deployments/:id/pods-live': {
    summary: 'Live pod state with usage totals',
    scope: 'read',
    response: z
      .object({
        pods: z.array(podRecord),
        warnings: z.array(podWarning),
        availableReplicas: z.number(),
        totalCpuUsage: z.number().nullable(),
        totalMemoryUsage: z.number().nullable(),
      })
      .passthrough(),
  },
  'GET /deployments/:id/metrics': {
    summary: 'CPU, memory, and network time series for a deployment',
    scope: 'read',
    request: z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      step: z.string().optional(),
    }),
    response: metricsResponse,
  },
  'GET /deployments/:id/logs': {
    summary: 'Build logs and status (logs redacted for viewers)',
    scope: 'read',
    response: z
      .object({
        logs: z.string(),
        status: z.string(),
        buildError: z.string().nullable(),
      })
      .passthrough(),
  },
  'GET /deployments/:id/image-history': {
    summary: 'List image history entries',
    scope: 'read',
    response: z.array(imageHistoryRecord),
  },
  'GET /deployments/:id/image-history/:imageHistoryId/logs': {
    summary: 'Build logs for an image history entry',
    scope: 'read',
    response: z.object({ logs: z.string() }).passthrough(),
  },
  'GET /deployments/:id/killed-containers': {
    summary: 'List recently killed containers with captured metadata',
    scope: 'read',
    response: z.array(killedContainerMeta),
  },
  'GET /deployments/:id/killed-containers/:entryId/logs': {
    summary: 'Captured logs of a killed container',
    scope: 'read',
    response: killedContainerMeta.extend({ logs: z.string() }),
  },
  'POST /deployments/:deploymentId/services': {
    summary: 'Create a service for a deployment',
    scope: 'deploy',
    request: z.object({
      name: z.string(),
      ports: z.array(portInput),
      exposePublic: z.boolean().optional(),
      domain: z.string().nullable().optional(),
    }),
    response: deploymentWithRelations,
  },
  'PUT /deployments/:deploymentId/services/:serviceId': {
    summary: 'Update service ports and domain',
    scope: 'deploy',
    request: z.object({
      ports: z.array(portInput).optional(),
      domain: z.string().nullable().optional(),
    }),
    response: deploymentWithRelations,
  },
  'DELETE /deployments/:deploymentId/services/:serviceId': {
    summary: 'Delete a service from a deployment',
    scope: 'deploy',
    response: deploymentWithRelations,
  },
  'PATCH /deployments/:deploymentId/services/:serviceId/exposure': {
    summary: 'Toggle public exposure of a service',
    scope: 'deploy',
    request: z.object({ exposePublic: z.boolean() }),
    response: deploymentWithRelations,
  },
  'POST /deployments/:deploymentId/services/:serviceId/ports/:portId/public': {
    summary: 'Expose a service port on the public IP',
    scope: 'deploy',
    response: z
      .object({
        enabled: z.boolean(),
        host: z.string(),
        ip: z.string(),
        port: z.number(),
        protocol: z.string(),
      })
      .passthrough(),
  },
  'DELETE /deployments/:deploymentId/services/:serviceId/ports/:portId/public': {
    summary: 'Remove the public exposure of a service port',
    scope: 'deploy',
    response: z.object({ enabled: z.boolean() }).passthrough(),
  },
  'POST /deployments/:id/ingresses': {
    summary: 'Create an ingress for a deployment',
    scope: 'deploy',
    request: deploymentIngressRequest,
    response: deploymentWithRelations,
  },
  'PUT /deployments/:deploymentId/ingresses/:ingressId': {
    summary: 'Update a deployment ingress',
    scope: 'deploy',
    request: deploymentIngressRequest,
    response: deploymentWithRelations,
  },
  'DELETE /deployments/:deploymentId/ingresses/:ingressId': {
    summary: 'Delete a deployment ingress',
    scope: 'deploy',
    response: deploymentWithRelations,
  },
  'GET /ingresses/:id': {
    summary: 'Get an ingress by id with resolved routes',
    scope: 'read',
    response: ingressRecord.extend({
      tlsEnabled: z.boolean(),
      address: z.string().nullable().optional(),
      routes: z.array(ingressRouteRecord),
      deployment: deploymentBase.nullable().optional(),
      project: projectRef.optional(),
    }),
  },
  'POST /projects/:id/ingresses': {
    summary: 'Create a project-level ingress (returns the full project)',
    scope: 'deploy',
    request: projectIngressRequest,
  },
  'PUT /projects/:id/ingresses/:ingressId': {
    summary: 'Update a project-level ingress (returns the full project)',
    scope: 'deploy',
    request: projectIngressRequest,
  },
  'GET /projects/:id/ingresses/:ingressId': {
    summary: 'Get a project-level ingress with resolved routes',
    scope: 'read',
    response: z
      .object({
        id: z.string(),
        name: z.string(),
        host: z.string(),
        path: z.string(),
        tlsEnabled: z.boolean(),
        routes: z.array(ingressRouteRecord),
        basicAuthEnabled: z.boolean(),
        protectionMode: z.enum(['none', 'password', 'orchard']),
        project: projectRef,
      })
      .passthrough(),
  },
  'DELETE /projects/:id/ingresses/:ingressId': {
    summary: 'Delete a project-level ingress',
    scope: 'deploy',
    response: z.object({ success: z.boolean() }).passthrough(),
  },
  'GET /projects/:id/ingresses/:ingressId/protection': {
    summary: 'Get ingress protection settings',
    scope: 'read',
    response: protectionResponse,
  },
  'PUT /projects/:id/ingresses/:ingressId/protection': {
    summary: 'Update ingress protection mode',
    scope: 'deploy',
    request: z.object({
      mode: z.enum(['none', 'password', 'orchard']),
      password: z.string().optional(),
    }),
    response: protectionResponse,
  },
  'POST /projects/ingresses/validate-dns': {
    summary: 'Validate that a custom domain points at the ingress CNAME',
    scope: 'read',
    request: z.object({ projectId: z.string(), domain: z.string() }),
    response: z.object({ valid: z.boolean(), message: z.string() }).passthrough(),
  },
  'GET /deployments/:id/auto-deploy': {
    summary: 'Get auto-deploy status',
    scope: 'read',
    response: z
      .object({
        enabled: z.boolean(),
        branch: z.string().nullable(),
        appInstalled: z.boolean(),
      })
      .passthrough(),
  },
  'POST /deployments/:id/auto-deploy/enable': {
    summary: 'Enable auto-deploy for a branch',
    scope: 'deploy',
    request: z.object({ branch: z.string() }),
    response: deploymentWithRelations,
  },
  'POST /deployments/:id/auto-deploy/disable': {
    summary: 'Disable auto-deploy',
    scope: 'deploy',
    response: deploymentWithRelations,
  },
  'GET /deployments/:id/github-deployments': {
    summary: 'List GitHub Deployments API records for a deployment',
    scope: 'read',
    response: z.array(githubDeploymentRecord),
  },
  'GET /deployments/:id/webhook-tokens': {
    summary: 'List webhook tokens (hashes only, never the secret)',
    scope: 'read',
    response: z.array(
      z
        .object({
          id: z.string(),
          label: z.string().nullable(),
          createdAt: z.string(),
          lastUsedAt: z.string().nullable(),
        })
        .passthrough(),
    ),
  },
  'POST /deployments/:id/webhook-tokens': {
    summary: 'Create a webhook token (plaintext returned once)',
    scope: 'deploy',
    request: z.object({ label: z.string().optional() }),
    response: z
      .object({
        id: z.string(),
        token: z.string(),
        label: z.string().nullable(),
        createdAt: z.string(),
      })
      .passthrough(),
  },
  'DELETE /deployments/:id/webhook-tokens/:tokenId': {
    summary: 'Delete a webhook token',
    scope: 'deploy',
    response: z.object({ ok: z.boolean() }).passthrough(),
  },
};
