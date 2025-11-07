import { Injectable, BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

interface BuildJobOptions {
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  imageName: string;
  tag?: string;
  deploymentId?: string;
  accessToken?: string;
  target?: string;
  buildFromRoot?: boolean;
  buildType?: 'dockerfile' | 'railpack';
  envVars?: Record<string, string>;
}

interface BuildJobStatus {
  jobName: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  logs?: string;
  imageRef?: string;
}

@Injectable()
export class ImageBuilderService {
  private kc: k8s.KubeConfig | null = null;
  private readonly builderNamespace = process.env.BUILDER_NAMESPACE || 'orchard-builders';
  // Internal Harbor registry for pushing (HTTP on port 80)
  private readonly harborRegistryPush = process.env.DOCKER_REGISTRY_PUSH || 'harbor-core.harbor.svc.cluster.local';
  private readonly harborRegistryPull = process.env.DOCKER_REGISTRY_PULL || 'harbor.1mp.dev';
  private readonly harborProject = 'orchard';

  // S3/R2 cache configuration
  // For Cloudflare R2, the endpoint format is: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  private readonly s3CacheEnabled = process.env.BUILDKIT_S3_CACHE_ENABLED === 'true';
  private readonly r2AccountId = process.env.R2_ACCOUNT_ID;
  private readonly s3Endpoint = process.env.BUILDKIT_S3_ENDPOINT ||
    (this.r2AccountId ? `https://${this.r2AccountId}.r2.cloudflarestorage.com` : process.env.R2_ENDPOINT);
  private readonly s3Region = process.env.BUILDKIT_S3_REGION || 'auto';
  private readonly s3Bucket = process.env.BUILDKIT_S3_BUCKET || process.env.R2_BUCKET_NAME || 'buildkit-cache';
  private readonly s3AccessKeyId = process.env.BUILDKIT_S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
  private readonly s3SecretAccessKey = process.env.BUILDKIT_S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
  private readonly s3CachePrefix = process.env.BUILDKIT_S3_CACHE_PREFIX || 'buildkit-cache/';

  constructor(private readonly prisma: PrismaService) {
    this.initKubeConfig();
  }

  private initKubeConfig() {
    try {
      this.kc = new k8s.KubeConfig();
      if (process.env.KUBECONFIG_BASE64) {
        let base64Value = process.env.KUBECONFIG_BASE64.trim();
        while ((base64Value.startsWith('"') && base64Value.endsWith('"')) ||
               (base64Value.startsWith("'") && base64Value.endsWith("'"))) {
          base64Value = base64Value.slice(1, -1).trim();
        }
        const decoded = Buffer.from(base64Value, 'base64').toString('utf-8');
        this.kc.loadFromString(decoded);
      } else if (process.env.KUBECONFIG_PATH) {
        let configPath = process.env.KUBECONFIG_PATH.trim();
        while ((configPath.startsWith('"') && configPath.endsWith('"')) ||
               (configPath.startsWith("'") && configPath.endsWith("'"))) {
          configPath = configPath.slice(1, -1).trim();
        }
        if (!configPath.includes('/') && !configPath.includes('\\') && configPath.length > 100) {
          const decoded = Buffer.from(configPath, 'base64').toString('utf-8');
          if (decoded.includes('apiVersion:') || decoded.includes('kind: Config')) {
            this.kc.loadFromString(decoded);
          } else {
            this.kc.loadFromFile(configPath);
          }
        } else {
          this.kc.loadFromFile(configPath);
        }
      } else {
        this.kc.loadFromDefault();
      }
      console.log('[ImageBuilder] Successfully loaded kubeconfig');
    } catch (error) {
      console.error('[ImageBuilder] Error loading kubeconfig:', error.message);
      this.kc = null;
    }
  }

  private ensureKubeConfig() {
    if (!this.kc) {
      throw new BadRequestException('Kubernetes API not available');
    }
  }

  private generateJobName(imageName: string): string {
    const hash = crypto.randomBytes(4).toString('hex');
    const sanitized = imageName.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
    return `image-builder-${sanitized}-${hash}`;
  }

  private async appendLog(deploymentId: string | undefined, message: string, level: 'INFO' | 'ERROR' | 'WARNING' = 'INFO') {
    if (!deploymentId) return;

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildLogs: true },
      });

      const currentLogs = deployment?.buildLogs || '';
      const timestamp = Date.now();
      const formattedMessage = `[${timestamp}] [${level}] ${message}`;
      const newLogs = currentLogs + formattedMessage + '\n';

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildLogs: newLogs },
      });
    } catch (error) {
      console.error('[ImageBuilder] Failed to append log:', error);
    }
  }

  private async setBuildStep(deploymentId: string | undefined, step: string) {
    if (!deploymentId) return;

    try {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildStep: step },
      });
    } catch (error) {
      console.error('[ImageBuilder] Failed to set build step:', error);
    }
  }

  async ensureBuilderNamespace(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    const namespaceLabels = {
      'app.kubernetes.io/managed-by': 'orchard-image-builder',
      'purpose': 'image-builds',
      // Required for BuildKit privileged containers - exempts from PodSecurity
      'pod-security.kubernetes.io/enforce': 'privileged',
      'pod-security.kubernetes.io/audit': 'privileged',
      'pod-security.kubernetes.io/warn': 'privileged',
    };

    try {
      const existingNs = await coreApi.readNamespace(this.builderNamespace);
      console.log(`[ImageBuilder] Namespace ${this.builderNamespace} already exists`);

      // Check if pod-security labels are set, if not, patch the namespace
      const existingLabels = existingNs.body.metadata?.labels || {};
      if (existingLabels['pod-security.kubernetes.io/enforce'] !== 'privileged') {
        console.log(`[ImageBuilder] Patching namespace ${this.builderNamespace} with pod-security labels`);
        await coreApi.patchNamespace(
          this.builderNamespace,
          { metadata: { labels: namespaceLabels } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
        );
      }
    } catch (error) {
      if (error.statusCode === 404) {
        console.log(`[ImageBuilder] Creating namespace ${this.builderNamespace}`);
        await coreApi.createNamespace({
          metadata: {
            name: this.builderNamespace,
            labels: namespaceLabels,
          },
        });
      } else {
        throw error;
      }
    }
  }

  async ensureBuilderSecrets(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    // Create Harbor registry credentials secret
    const harborUsername = process.env.HARBOR_USERNAME || 'admin';
    const harborPassword = process.env.HARBOR_PASSWORD || '';

    const dockerConfigJson = {
      auths: {
        [this.harborRegistryPush]: {
          username: harborUsername,
          password: harborPassword,
          auth: Buffer.from(`${harborUsername}:${harborPassword}`).toString('base64'),
        },
        [this.harborRegistryPull]: {
          username: harborUsername,
          password: harborPassword,
          auth: Buffer.from(`${harborUsername}:${harborPassword}`).toString('base64'),
        },
      },
    };

    const registrySecretName = 'harbor-registry-creds';
    try {
      await coreApi.readNamespacedSecret(registrySecretName, this.builderNamespace);
      // Update existing secret
      await coreApi.replaceNamespacedSecret(registrySecretName, this.builderNamespace, {
        metadata: {
          name: registrySecretName,
          namespace: this.builderNamespace,
        },
        type: 'kubernetes.io/dockerconfigjson',
        data: {
          '.dockerconfigjson': Buffer.from(JSON.stringify(dockerConfigJson)).toString('base64'),
        },
      });
    } catch (error) {
      if (error.statusCode === 404) {
        await coreApi.createNamespacedSecret(this.builderNamespace, {
          metadata: {
            name: registrySecretName,
            namespace: this.builderNamespace,
          },
          type: 'kubernetes.io/dockerconfigjson',
          data: {
            '.dockerconfigjson': Buffer.from(JSON.stringify(dockerConfigJson)).toString('base64'),
          },
        });
      } else {
        throw error;
      }
    }

    // Create S3 cache credentials secret if enabled
    if (this.s3CacheEnabled && this.s3AccessKeyId && this.s3SecretAccessKey) {
      const s3SecretName = 'buildkit-s3-cache-creds';
      try {
        await coreApi.readNamespacedSecret(s3SecretName, this.builderNamespace);
        await coreApi.replaceNamespacedSecret(s3SecretName, this.builderNamespace, {
          metadata: {
            name: s3SecretName,
            namespace: this.builderNamespace,
          },
          type: 'Opaque',
          stringData: {
            AWS_ACCESS_KEY_ID: this.s3AccessKeyId,
            AWS_SECRET_ACCESS_KEY: this.s3SecretAccessKey,
          },
        });
      } catch (error) {
        if (error.statusCode === 404) {
          await coreApi.createNamespacedSecret(this.builderNamespace, {
            metadata: {
              name: s3SecretName,
              namespace: this.builderNamespace,
            },
            type: 'Opaque',
            stringData: {
              AWS_ACCESS_KEY_ID: this.s3AccessKeyId,
              AWS_SECRET_ACCESS_KEY: this.s3SecretAccessKey,
            },
          });
        } else {
          throw error;
        }
      }
    }

    // Create BuildKit configuration ConfigMap
    await this.ensureBuilderConfigMap();
  }

  async ensureBuilderConfigMap(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    const configMapName = 'buildkit-config';

    // Build unique registry entries (avoid duplicates)
    const registries = new Set<string>([
      'harbor-core.harbor.svc.cluster.local',
      '178.156.144.127',
    ]);
    if (this.harborRegistryPush && !registries.has(this.harborRegistryPush)) {
      registries.add(this.harborRegistryPush);
    }

    // For plain HTTP registries, use ONLY http=true
    // insecure=true means "HTTPS with self-signed cert", NOT "allow HTTP"
    // See: https://github.com/moby/buildkit/issues/4458
    const registryConfigs = Array.from(registries)
      .map(reg => `[registry."${reg}"]
  http = true`)
      .join('\n\n');

    const buildkitConfig = `# BuildKit daemon configuration
debug = true

[worker.oci]
  max-parallelism = 4

[worker.containerd]
  enabled = false

# Registry configuration for insecure registries
# The key must match exactly how the registry is referenced in the image name
${registryConfigs}
`;

    try {
      await coreApi.readNamespacedConfigMap(configMapName, this.builderNamespace);
      await coreApi.replaceNamespacedConfigMap(configMapName, this.builderNamespace, {
        metadata: {
          name: configMapName,
          namespace: this.builderNamespace,
          labels: {
            'app.kubernetes.io/name': 'image-builder',
            'app.kubernetes.io/managed-by': 'orchard',
          },
        },
        data: {
          'buildkitd.toml': buildkitConfig,
        },
      });
    } catch (error) {
      if (error.statusCode === 404) {
        await coreApi.createNamespacedConfigMap(this.builderNamespace, {
          metadata: {
            name: configMapName,
            namespace: this.builderNamespace,
            labels: {
              'app.kubernetes.io/name': 'image-builder',
              'app.kubernetes.io/managed-by': 'orchard',
            },
          },
          data: {
            'buildkitd.toml': buildkitConfig,
          },
        });
      } else {
        throw error;
      }
    }
  }

  private buildCacheArgs(): string[] {
    if (!this.s3CacheEnabled || !this.s3Endpoint || !this.s3Bucket) {
      console.log('[ImageBuilder] S3 cache disabled or not configured');
      return [];
    }

    console.log(`[ImageBuilder] S3 cache enabled - endpoint: ${this.s3Endpoint}, bucket: ${this.s3Bucket}`);

    // BuildKit S3 cache format for Cloudflare R2
    // R2 is S3-compatible but requires specific settings:
    // - endpoint_url must be the full R2 endpoint
    // - region should be 'auto' for R2
    // - use_path_style should be true for R2
    // Note: buildctl uses --import-cache and --export-cache (not --cache-from/--cache-to)
    const importCache = `type=s3,endpoint_url=${this.s3Endpoint},bucket=${this.s3Bucket},region=${this.s3Region},prefix=${this.s3CachePrefix},use_path_style=true`;
    const exportCache = `type=s3,endpoint_url=${this.s3Endpoint},bucket=${this.s3Bucket},region=${this.s3Region},prefix=${this.s3CachePrefix},mode=max,use_path_style=true`;

    return [
      '--import-cache', importCache,
      '--export-cache', exportCache,
    ];
  }

  async createBuildJob(options: BuildJobOptions): Promise<string> {
    this.ensureKubeConfig();

    const {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag = 'latest',
      deploymentId,
      accessToken,
      target,
      buildFromRoot = false,
      buildType = 'dockerfile',
      envVars = {},
    } = options;

    await this.ensureBuilderNamespace();
    await this.ensureBuilderSecrets();
    await this.ensureServiceAccount();

    const jobName = this.generateJobName(imageName);
    const fullImageName = `${this.harborRegistryPush}/${this.harborProject}/${imageName}:${tag}`;

    const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    await this.appendLog(deploymentId, `Creating image-builder pod: ${jobName} (${buildMethodLabel})`);
    await this.setBuildStep(deploymentId, 'creating-builder');

    // Build the git clone URL with optional access token
    let cloneUrl = repoUrl;
    if (accessToken && repoUrl.includes('github.com')) {
      // GitHub App installation tokens start with 'ghs_' and need x-access-token format
      // User OAuth tokens can use the simpler format
      if (accessToken.startsWith('ghs_')) {
        cloneUrl = repoUrl.replace('https://github.com/', `https://x-access-token:${accessToken}@github.com/`);
      } else {
        cloneUrl = repoUrl.replace('https://github.com/', `https://${accessToken}@github.com/`);
      }
    }

    // Compute secrets hash for Railpack layer invalidation
    const secretsHash = this.computeSecretsHash(envVars);
    // Use deployment ID as cache key for multi-tenant isolation
    const cacheKey = deploymentId ? `orchard-${deploymentId.slice(0, 8)}` : undefined;

    // Build the buildctl args for daemonless mode
    const buildctlArgs = this.generateBuildctlArgs({
      dockerfilePath,
      fullImageName,
      target,
      buildFromRoot,
      buildType,
      envVars,
      secretsHash,
      cacheKey,
    });

    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);

    // Build init containers list
    const initContainers: k8s.V1Container[] = [
      {
        name: 'git-clone',
        image: 'alpine/git:latest',
        command: ['/bin/sh', '-c'],
        args: [
          `set -ex
echo "=== Cloning repository ==="
echo "Repository: ${cloneUrl.replace(/\/\/[^@]+@/, '//***@')}"
echo "Branch: ${branch}"

git clone --depth 1 --branch "${branch}" "${cloneUrl}" /workspace

echo "=== Repository cloned successfully ==="
ls -la /workspace
`,
        ],
        volumeMounts: [
          {
            name: 'workspace',
            mountPath: '/workspace',
          },
        ],
        resources: {
          requests: {
            cpu: '100m',
            memory: '256Mi',
          },
          limits: {
            cpu: '500m',
            memory: '512Mi',
          },
        },
      },
    ];

    // For Dockerfile builds with env vars, prepend ARG/ENV declarations
    // This makes build-args available as environment variables in RUN commands
    if (buildType === 'dockerfile' && Object.keys(envVars).length > 0) {
      const argDeclarations = Object.keys(envVars).map(key => `ARG ${key}\nENV ${key}=\${${key}}`).join('\n');
      
      initContainers.push({
        name: 'inject-build-args',
        image: 'alpine:latest',
        command: ['/bin/sh', '-c'],
        args: [
          `set -ex
echo "=== Injecting ARG/ENV declarations into Dockerfile ==="

DOCKERFILE_PATH="${buildFromRoot ? dockerfilePath : dockerfilePath}"
DOCKERFILE="/workspace/\${DOCKERFILE_PATH}"

if [ ! -f "\${DOCKERFILE}" ]; then
  echo "Error: Dockerfile not found at \${DOCKERFILE}"
  ls -la /workspace
  exit 1
fi

# Create temp file with ARG/ENV declarations
cat > /tmp/args.txt << 'EOF'
# Auto-injected build arguments and environment variables
${argDeclarations}

EOF

# Prepend to Dockerfile (after FROM line to respect multi-stage builds)
awk 'NR==FNR {a[NR]=$0; next} /^FROM / && !done {print; system("cat /tmp/args.txt"); done=1; next} 1' /tmp/args.txt "\${DOCKERFILE}" > /tmp/dockerfile.new && mv /tmp/dockerfile.new "\${DOCKERFILE}"

echo "=== Dockerfile updated with build args ==="
head -n 20 "\${DOCKERFILE}"
`,
        ],
        workingDir: '/workspace',
        volumeMounts: [
          {
            name: 'workspace',
            mountPath: '/workspace',
          },
        ],
        resources: {
          requests: {
            cpu: '50m',
            memory: '64Mi',
          },
          limits: {
            cpu: '200m',
            memory: '128Mi',
          },
        },
      });
    }

    // For Railpack builds, add a second init container to run `railpack prepare`
    if (buildType === 'railpack') {
      // Build the env args for railpack prepare
      const envArgs = Object.entries(envVars)
        .filter(([, value]) => value && typeof value === 'string')
        .map(([key, value]) => `--env '${key}=${value.replace(/'/g, "'\\''")}'`)
        .join(' ');

      initContainers.push({
        name: 'railpack-prepare',
        image: 'ghcr.io/railwayapp/railpack-mise:latest',
        command: ['/bin/sh', '-c'],
        args: [
          `set -ex
echo "=== Installing curl ==="
if command -v apt-get >/dev/null 2>&1; then
  apt-get update && apt-get install -y curl
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl
fi

echo "=== Installing Railpack ==="
curl -sSL https://railpack.com/install.sh | sh
export PATH="$PATH:/root/.local/bin:/usr/local/bin"

echo "=== Running Railpack prepare ==="
cd /workspace
railpack prepare . --plan-out railpack-plan.json --info-out railpack-info.json ${envArgs}

echo "=== Railpack prepare completed ==="
echo "Generated files:"
ls -la railpack-plan.json railpack-info.json 2>/dev/null || echo "Warning: Some files may not have been generated"

# Show build info for logging
if [ -f railpack-info.json ]; then
  echo "=== Build Info ==="
  cat railpack-info.json
fi
`,
        ],
        workingDir: '/workspace',
        volumeMounts: [
          {
            name: 'workspace',
            mountPath: '/workspace',
          },
        ],
        resources: {
          requests: {
            cpu: '200m',
            memory: '512Mi',
          },
          limits: {
            cpu: '1',
            memory: '2Gi',
          },
        },
      });
    }

    // Create the build job with init containers and daemonless buildkit
    const job: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.builderNamespace,
        labels: {
          'app.kubernetes.io/name': 'image-builder',
          'app.kubernetes.io/managed-by': 'orchard',
          'orchard.dev/deployment-id': deploymentId || 'unknown',
          'orchard.dev/image-name': imageName.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 63),
          'orchard.dev/build-type': buildType,
        },
        annotations: {
          'orchard.dev/repo-url': repoUrl,
          'orchard.dev/branch': branch,
          'orchard.dev/full-image': fullImageName,
        },
      },
      spec: {
        ttlSecondsAfterFinished: 3600, // Cleanup job after 1 hour
        backoffLimit: 0, // Don't retry failed builds
        activeDeadlineSeconds: 1800, // 30 minute timeout
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'image-builder',
              'orchard.dev/deployment-id': deploymentId || 'unknown',
            },
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: 'image-builder',
            initContainers,
            containers: [
              {
                name: 'buildkit',
                image: 'moby/buildkit:latest',
                securityContext: {
                  privileged: true,
                },
                // Use buildctl-daemonless.sh - handles daemon startup internally
                command: ['buildctl-daemonless.sh'],
                args: buildctlArgs,
                workingDir: '/workspace',
                env: [
                  { name: 'DOCKER_CONFIG', value: '/root/.docker' },
                  { name: 'BUILDKITD_FLAGS', value: '--config /etc/buildkit/buildkitd.toml' },
                  ...(this.s3CacheEnabled ? [
                    {
                      name: 'AWS_ACCESS_KEY_ID',
                      valueFrom: {
                        secretKeyRef: {
                          name: 'buildkit-s3-cache-creds',
                          key: 'AWS_ACCESS_KEY_ID',
                          optional: true,
                        }
                      }
                    },
                    {
                      name: 'AWS_SECRET_ACCESS_KEY',
                      valueFrom: {
                        secretKeyRef: {
                          name: 'buildkit-s3-cache-creds',
                          key: 'AWS_SECRET_ACCESS_KEY',
                          optional: true,
                        }
                      }
                    },
                  ] : []),
                  // Pass build environment variables (needed for Railpack secrets and Dockerfile build-args)
                  ...Object.entries(envVars).map(([key, value]) => ({
                    name: key,
                    value: value,
                  })),
                ],
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/workspace',
                  },
                  {
                    name: 'docker-config',
                    mountPath: '/root/.docker',
                    readOnly: true,
                  },
                  {
                    name: 'buildkit-config',
                    mountPath: '/etc/buildkit',
                    readOnly: true,
                  },
                ],
                resources: {
                  requests: {
                    cpu: '500m',
                    memory: '1Gi',
                  },
                  limits: {
                    cpu: '4',
                    memory: '8Gi',
                  },
                },
              },
            ],
            volumes: [
              {
                name: 'workspace',
                emptyDir: {},
              },
              {
                name: 'docker-config',
                secret: {
                  secretName: 'harbor-registry-creds',
                  items: [
                    {
                      key: '.dockerconfigjson',
                      path: 'config.json',
                    },
                  ],
                },
              },
              {
                name: 'buildkit-config',
                configMap: {
                  name: 'buildkit-config',
                },
              },
            ],
          },
        },
      },
    };

    try {
      await batchApi.createNamespacedJob(this.builderNamespace, job);
      await this.appendLog(deploymentId, `Build job ${jobName} created successfully`);

      // Store the job name in deployment metadata for tracking
      if (deploymentId) {
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            buildStep: 'building',
          },
        });
      }

      return jobName;
    } catch (error) {
      const errorDetails = error.body ? JSON.stringify(error.body, null, 2) : error.message;
      const errorMsg = `Failed to create build job: ${error.message}${error.body ? `\nDetails: ${errorDetails}` : ''}`;
      await this.appendLog(deploymentId, errorMsg, 'ERROR');
      console.error('[ImageBuilder] Job creation error:', errorDetails);
      throw new BadRequestException(`Failed to create build job: ${error.message}`);
    }
  }

  private generateBuildctlArgsForDockerfile(options: {
    dockerfilePath: string;
    fullImageName: string;
    target?: string;
    buildFromRoot: boolean;
    envVars: Record<string, string>;
  }): string[] {
    const {
      dockerfilePath,
      fullImageName,
      target,
      buildFromRoot,
      envVars,
    } = options;

    // Determine dockerfile location and context
    let dockerfileDir = '.';
    let dockerfileName = 'Dockerfile';

    if (buildFromRoot) {
      // Build from root, dockerfile path is relative to root
      dockerfileName = dockerfilePath;
    } else {
      // Build from dockerfile's directory
      const parts = dockerfilePath.split('/');
      if (parts.length > 1) {
        dockerfileName = parts.pop()!;
        dockerfileDir = parts.join('/');
      } else {
        dockerfileName = dockerfilePath;
      }
    }

    const args: string[] = [
      'build',
      '--progress', 'plain',
      '--frontend', 'dockerfile.v0',
      '--local', `context=${buildFromRoot ? '.' : dockerfileDir}`,
      '--local', `dockerfile=${buildFromRoot ? '.' : dockerfileDir}`,
      '--opt', `filename=${dockerfileName}`,
      '--opt', 'platform=linux/amd64',
    ];

    // Add target if specified
    if (target) {
      args.push('--opt', `target=${target}`);
    }

    // Pass environment variables as build-args
    // Note: These will be available in the Dockerfile if declared with ARG
    // For security, sensitive values should not be used in ways that bake them into layers
    // The values are passed directly (not via shell expansion) to avoid exposure in process lists
    for (const [key, value] of Object.entries(envVars)) {
      args.push('--opt', `build-arg:${key}=${value}`);
    }

    // Add cache arguments
    const cacheArgs = this.buildCacheArgs();
    for (const cacheArg of cacheArgs) {
      args.push(cacheArg);
    }

    // Output to registry
    args.push('--output', `type=image,"name=${fullImageName}",push=true`);

    return args;
  }

  private generateBuildctlArgsForRailpack(options: {
    fullImageName: string;
    envVars: Record<string, string>;
    secretsHash: string;
    cacheKey?: string;
  }): string[] {
    const {
      fullImageName,
      envVars,
      secretsHash,
      cacheKey,
    } = options;

    const args: string[] = [
      'build',
      '--progress', 'plain',
      '--frontend', 'gateway.v0',
      '--opt', 'source=ghcr.io/railwayapp/railpack-frontend',
      '--local', 'context=.',
      '--local', 'dockerfile=.',
    ];

    if (secretsHash) {
      args.push('--opt', `build-arg:secrets-hash=${secretsHash}`);
    }

    if (cacheKey) {
      args.push('--opt', `build-arg:cache-key=${cacheKey}`);
    }

    for (const key of Object.keys(envVars)) {
      args.push('--secret', `id=${key},env=${key}`);
    }

    const cacheArgs = this.buildCacheArgs();
    for (const cacheArg of cacheArgs) {
      args.push(cacheArg);
    }

    args.push('--output', `type=image,"name=${fullImageName}",push=true`);

    return args;
  }

  private generateBuildctlArgs(options: {
    dockerfilePath: string;
    fullImageName: string;
    target?: string;
    buildFromRoot: boolean;
    buildType: 'dockerfile' | 'railpack';
    envVars: Record<string, string>;
    secretsHash?: string;
    cacheKey?: string;
  }): string[] {
    const { buildType, fullImageName, envVars, secretsHash, cacheKey, ...dockerfileOptions } = options;

    if (buildType === 'railpack') {
      return this.generateBuildctlArgsForRailpack({
        fullImageName,
        envVars,
        secretsHash: secretsHash || '',
        cacheKey,
      });
    }

    return this.generateBuildctlArgsForDockerfile({
      ...dockerfileOptions,
      fullImageName,
      envVars,
    });
  }

  private computeSecretsHash(envVars: Record<string, string>): string {
    const secrets = Object.entries(envVars)
      .filter(([, value]) => value && typeof value === 'string')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    if (!secrets) {
      return '';
    }

    return crypto.createHash('sha256').update(secrets).digest('hex');
  }

  async getBuildJobStatus(jobName: string): Promise<BuildJobStatus> {
    this.ensureKubeConfig();
    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    try {
      const job = await batchApi.readNamespacedJob(jobName, this.builderNamespace);
      const jobSpec = job.body;

      let status: BuildJobStatus['status'] = 'unknown';
      let logs = '';

      if (jobSpec.status?.succeeded && jobSpec.status.succeeded > 0) {
        status = 'succeeded';
      } else if (jobSpec.status?.failed && jobSpec.status.failed > 0) {
        status = 'failed';
      } else if (jobSpec.status?.active && jobSpec.status.active > 0) {
        status = 'running';
      } else {
        status = 'pending';
      }

      // Try to get logs from the pod
      try {
        const pods = await coreApi.listNamespacedPod(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `job-name=${jobName}`
        );

        if (pods.body.items.length > 0) {
          const podName = pods.body.items[0].metadata?.name;
          if (podName) {
            const logResponse = await coreApi.readNamespacedPodLog(
              podName,
              this.builderNamespace,
              'buildkit',
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              5000 // tail last 5000 lines
            );
            logs = logResponse.body;
          }
        }
      } catch (logError) {
        console.warn(`[ImageBuilder] Could not fetch logs for job ${jobName}:`, logError.message);
      }

      // Extract image reference from job annotations
      const imageRef = jobSpec.metadata?.annotations?.['orchard.dev/full-image'];

      return {
        jobName,
        status,
        logs,
        imageRef,
      };
    } catch (error) {
      if (error.statusCode === 404) {
        return {
          jobName,
          status: 'unknown',
          logs: 'Job not found',
        };
      }
      throw error;
    }
  }

  async waitForBuildJob(jobName: string, deploymentId?: string, timeoutMs: number = 1800000): Promise<BuildJobStatus> {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds

    await this.appendLog(deploymentId, `Waiting for build job ${jobName} to complete...`);

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getBuildJobStatus(jobName);

      if (status.status === 'succeeded') {
        await this.appendLog(deploymentId, `Build job ${jobName} completed successfully`);
        if (status.logs) {
          // Log the last portion of the build output
          const logLines = status.logs.split('\n').slice(-50).join('\n');
          await this.appendLog(deploymentId, `Build output:\n${logLines}`);
        }
        return status;
      }

      if (status.status === 'failed') {
        await this.appendLog(deploymentId, `Build job ${jobName} failed`, 'ERROR');
        if (status.logs) {
          await this.appendLog(deploymentId, `Build logs:\n${status.logs}`, 'ERROR');
        }
        throw new BadRequestException(`Build job failed: ${status.logs || 'Unknown error'}`);
      }

      // Log progress for running builds
      if (status.status === 'running' && status.logs) {
        const logLines = status.logs.split('\n');
        const recentLines = logLines.slice(-5).join('\n');
        if (recentLines.trim()) {
          await this.appendLog(deploymentId, `Build progress:\n${recentLines}`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    await this.appendLog(deploymentId, `Build job ${jobName} timed out after ${timeoutMs / 1000}s`, 'ERROR');
    throw new BadRequestException(`Build job timed out after ${timeoutMs / 1000} seconds`);
  }

  async deleteBuildJob(jobName: string): Promise<void> {
    this.ensureKubeConfig();
    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);

    try {
      await batchApi.deleteNamespacedJob(
        jobName,
        this.builderNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'Background'
      );
      console.log(`[ImageBuilder] Deleted job ${jobName}`);
    } catch (error) {
      if (error.statusCode !== 404) {
        console.error(`[ImageBuilder] Failed to delete job ${jobName}:`, error.message);
      }
    }
  }

  async buildAndPush(options: BuildJobOptions): Promise<string> {
    const { imageName, tag = 'latest', deploymentId } = options;

    try {
      await this.appendLog(deploymentId, `Starting BuildKit build for ${options.repoUrl}@${options.branch}`);
      await this.setBuildStep(deploymentId, 'starting');

      // Create the build job
      const jobName = await this.createBuildJob(options);

      // Wait for it to complete
      const status = await this.waitForBuildJob(jobName, deploymentId);

      // Get the final image reference
      const fullImagePath = `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`;

      await this.appendLog(deploymentId, `Build and push completed successfully!`);
      await this.appendLog(deploymentId, `Image available at: ${fullImagePath}`);
      await this.setBuildStep(deploymentId, 'completed');

      // Cleanup the job (optional, since TTL will also clean it up)
      await this.deleteBuildJob(jobName);

      return fullImagePath;
    } catch (error) {
      const errorMsg = `Build failed: ${error.message}`;
      console.error('[ImageBuilder]', errorMsg);
      await this.appendLog(deploymentId, errorMsg, 'ERROR');
      await this.setBuildStep(deploymentId, 'failed');

      if (deploymentId) {
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'failed',
            buildError: error.message,
          },
        });
      }

      throw error;
    }
  }

  async ensureServiceAccount(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    const rbacApi = this.kc!.makeApiClient(k8s.RbacAuthorizationV1Api);

    const saName = 'image-builder';

    // Create ServiceAccount
    try {
      await coreApi.readNamespacedServiceAccount(saName, this.builderNamespace);
    } catch (error) {
      if (error.statusCode === 404) {
        await coreApi.createNamespacedServiceAccount(this.builderNamespace, {
          metadata: {
            name: saName,
            namespace: this.builderNamespace,
          },
        });
      }
    }

    // Create or update Role for the builder
    const roleName = 'image-builder-role';
    const roleRules = [
      {
        apiGroups: [''],
        resources: ['pods', 'pods/log'],
        verbs: ['get', 'list', 'watch'],
      },
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
      },
      {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
    ];
    
    try {
      await rbacApi.readNamespacedRole(roleName, this.builderNamespace);
      // Role exists, update it to ensure it has the correct permissions
      await rbacApi.replaceNamespacedRole(roleName, this.builderNamespace, {
        metadata: {
          name: roleName,
          namespace: this.builderNamespace,
        },
        rules: roleRules,
      });
    } catch (error) {
      if (error.statusCode === 404) {
        await rbacApi.createNamespacedRole(this.builderNamespace, {
          metadata: {
            name: roleName,
            namespace: this.builderNamespace,
          },
          rules: roleRules,
        });
      } else {
        throw error;
      }
    }

    // Create RoleBinding
    const roleBindingName = 'image-builder-rolebinding';
    try {
      await rbacApi.readNamespacedRoleBinding(roleBindingName, this.builderNamespace);
    } catch (error) {
      if (error.statusCode === 404) {
        await rbacApi.createNamespacedRoleBinding(this.builderNamespace, {
          metadata: {
            name: roleBindingName,
            namespace: this.builderNamespace,
          },
          subjects: [
            {
              kind: 'ServiceAccount',
              name: saName,
              namespace: this.builderNamespace,
            },
          ],
          roleRef: {
            kind: 'Role',
            name: roleName,
            apiGroup: 'rbac.authorization.k8s.io',
          },
        });
      }
    }
  }

  getImagePath(imageName: string, tag: string = 'latest'): string {
    return `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`;
  }
}
