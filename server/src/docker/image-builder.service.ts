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

  private sanitizeLogMessage(message: string): string {
    let sanitized = message;
    
    sanitized = sanitized.replace(/(x-access-token:|ghs_|ghp_|github_pat_)[a-zA-Z0-9_]+/gi, '***REDACTED***');
    
    sanitized = sanitized.replace(/https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi, 'https://***@github.com');
    
    sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');
    
    sanitized = sanitized.replace(/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-\.]+/gi, '$1 ***REDACTED***');
    
    sanitized = sanitized.replace(/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi, '$1=***REDACTED***');
    
    return sanitized;
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
      const sanitizedMessage = this.sanitizeLogMessage(message);
      const formattedMessage = `[${timestamp}] [${level}] ${sanitizedMessage}`;
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
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStepTimestamps: true },
      });

      const timestamps = (deployment?.buildStepTimestamps as Record<string, number> | null) || {};
      timestamps[step] = Date.now();

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildStep: step, buildStepTimestamps: timestamps },
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

    // Internal registries that use plain HTTP (no TLS)
    const httpRegistries = new Set<string>([
      'harbor-core.harbor.svc.cluster.local',
      '178.156.144.127',
    ]);

    // For plain HTTP registries, use ONLY http=true
    // insecure=true means "HTTPS with self-signed cert", NOT "allow HTTP"
    // See: https://github.com/moby/buildkit/issues/4458
    // External registries (e.g. OVH, Docker Hub) use HTTPS and should NOT have http=true
    const registryConfigs = Array.from(httpRegistries)
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

  private buildCacheArgs(imageName?: string): string[] {
    if (!this.s3CacheEnabled || !this.s3Endpoint || !this.s3Bucket) {
      console.log('[ImageBuilder] S3 cache disabled or not configured');
      return [];
    }

    // Namespace cache per image to prevent cross-deployment cache contamination.
    // Without this, BuildKit can resolve a multi-stage build's final image config
    // from cached layers of a different deployment sharing the same base image,
    // resulting in missing CMD/WORKDIR/ENTRYPOINT from the runner stage.
    const cachePrefix = imageName
      ? `${this.s3CachePrefix}${imageName.replace(/[^a-z0-9-]/gi, '-')}/`
      : this.s3CachePrefix;

    console.log(`[ImageBuilder] S3 cache enabled - endpoint: ${this.s3Endpoint}, bucket: ${this.s3Bucket}, prefix: ${cachePrefix}`);

    // BuildKit S3 cache format for Cloudflare R2
    // R2 is S3-compatible but requires specific settings:
    // - endpoint_url must be the full R2 endpoint
    // - region should be 'auto' for R2
    // - use_path_style should be true for R2
    // Note: buildctl uses --import-cache and --export-cache (not --cache-from/--cache-to)
    const importCache = `type=s3,endpoint_url=${this.s3Endpoint},bucket=${this.s3Bucket},region=${this.s3Region},prefix=${cachePrefix},use_path_style=true`;
    const exportCache = `type=s3,endpoint_url=${this.s3Endpoint},bucket=${this.s3Bucket},region=${this.s3Region},prefix=${cachePrefix},mode=max,use_path_style=true`;

    return [
      '--import-cache', importCache,
      '--export-cache', exportCache,
    ];
  }

  private generateBuildScriptWithCacheFallback(buildctlArgs: string[]): string {
    const cacheArgs = this.buildCacheArgs();
    const hasCacheEnabled = cacheArgs.length > 0;

    const argsWithCache = [...buildctlArgs].map(arg => 
      arg.includes(' ') || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg
    ).join(' ');

    if (!hasCacheEnabled) {
      return this.generateRetryScript(`buildctl-daemonless.sh ${argsWithCache}`);
    }

    const argsWithoutCache = buildctlArgs.filter((arg, idx, arr) => {
      if (arg === '--import-cache' || arg === '--export-cache') {
        return false;
      }
      if (idx > 0 && (arr[idx - 1] === '--import-cache' || arr[idx - 1] === '--export-cache')) {
        return false;
      }
      return true;
    }).map(arg => 
      arg.includes(' ') || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg
    ).join(' ');

    return `
set +e

echo "=== Attempting build with S3 cache enabled ==="
BUILD_OUTPUT=$(mktemp)
FIFO=$(mktemp -u)
mkfifo "$FIFO"

MAX_RETRIES=3
RETRY_DELAY=2

for attempt in $(seq 1 $MAX_RETRIES); do
  if [ $attempt -gt 1 ]; then
    WAIT_TIME=$((RETRY_DELAY * (2 ** (attempt - 2))))
    echo "=== Retry attempt $attempt/$MAX_RETRIES (waiting \${WAIT_TIME}s) ==="
    sleep $WAIT_TIME
  fi
  [ -p "$FIFO" ] || mkfifo "$FIFO"
  
  buildctl-daemonless.sh ${argsWithCache} > "$FIFO" 2>&1 &
  BUILD_PID=$!
  tee "$BUILD_OUTPUT" < "$FIFO"
  wait $BUILD_PID
  BUILD_EXIT_CODE=$?
  rm -f "$FIFO"
  
  if [ "$BUILD_EXIT_CODE" -eq 0 ]; then
    echo "=== Build completed successfully with cache ==="
    rm -f "$BUILD_OUTPUT" "$FIFO"
    exit 0
  fi
  
  echo "=== Build with cache failed (exit code: $BUILD_EXIT_CODE) ==="
  
  if grep -qi "timeout\\|connection refused\\|connection reset\\|proxyconnect\\|network\\|dial tcp\\|i/o timeout\\|EOF" "$BUILD_OUTPUT"; then
    if [ $attempt -lt $MAX_RETRIES ]; then
      echo "=================================================="
      echo "WARNING: Network/timeout error detected"
      echo "Retrying..."
      echo "=================================================="
      continue
    fi
  fi
  
  break
done

if grep -qi "failed to check file presence in cache\\|BadRequest\\|Bad Request\\|operation error S3\\|api error BadRequest" "$BUILD_OUTPUT"; then
  echo "=================================================="
  echo "WARNING: S3 cache operation failed"
  echo "Failed to save/load cache - skipping cache"
  echo "Retrying without cache..."
  echo "=================================================="
  
  rm -f "$BUILD_OUTPUT"
  BUILD_OUTPUT=$(mktemp)
  FIFO=$(mktemp -u)
  mkfifo "$FIFO"
  
  echo "=== Retrying build without cache ==="
  
  for attempt in $(seq 1 $MAX_RETRIES); do
    if [ $attempt -gt 1 ]; then
      WAIT_TIME=$((RETRY_DELAY * (2 ** (attempt - 2))))
      echo "=== Retry attempt $attempt/$MAX_RETRIES (waiting \${WAIT_TIME}s) ==="
      sleep $WAIT_TIME
    fi
    rm -f "$FIFO"
    mkfifo "$FIFO"
    
    buildctl-daemonless.sh ${argsWithoutCache} > "$FIFO" 2>&1 &
    BUILD_PID=$!
    tee "$BUILD_OUTPUT" < "$FIFO"
    wait $BUILD_PID
    BUILD_EXIT_CODE=$?
    
    if [ "$BUILD_EXIT_CODE" -eq 0 ]; then
      echo "=== Build completed successfully (without cache) ==="
      rm -f "$BUILD_OUTPUT" "$FIFO"
      exit 0
    fi
    
    echo "=== Build without cache failed (exit code: $BUILD_EXIT_CODE) ==="
    
    if grep -qi "timeout\\|connection refused\\|connection reset\\|proxyconnect\\|network\\|dial tcp\\|i/o timeout\\|EOF" "$BUILD_OUTPUT"; then
      if [ $attempt -lt $MAX_RETRIES ]; then
        echo "=================================================="
        echo "WARNING: Network/timeout error detected"
        echo "Retrying..."
        echo "=================================================="
        continue
      fi
    fi
    
    break
  done
  
  rm -f "$BUILD_OUTPUT" "$FIFO"
  exit $BUILD_EXIT_CODE
else
  echo "=== Build failed with non-cache error ==="
  rm -f "$BUILD_OUTPUT" "$FIFO"
  exit $BUILD_EXIT_CODE
fi
`.trim();
  }

  private generateRetryScript(command: string): string {
    return `
set +e

MAX_RETRIES=3
RETRY_DELAY=2
BUILD_OUTPUT=$(mktemp)
FIFO=$(mktemp -u)

for attempt in $(seq 1 $MAX_RETRIES); do
  if [ $attempt -gt 1 ]; then
    WAIT_TIME=$((RETRY_DELAY * (2 ** (attempt - 2))))
    echo "=== Retry attempt $attempt/$MAX_RETRIES (waiting \${WAIT_TIME}s) ==="
    sleep $WAIT_TIME
  fi
  mkfifo "$FIFO"
  
  ( ${command} > "$FIFO" 2>&1 ) &
  BUILD_PID=$!
  tee "$BUILD_OUTPUT" < "$FIFO"
  wait $BUILD_PID
  EXIT_CODE=$?
  rm -f "$FIFO"
  
  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "=== Build completed successfully ==="
    rm -f "$BUILD_OUTPUT"
    exit 0
  fi
  
  echo "=== Build failed (exit code: $EXIT_CODE) ==="
  
  if grep -qi "timeout\\|connection refused\\|connection reset\\|proxyconnect\\|network\\|dial tcp\\|i/o timeout\\|EOF" "$BUILD_OUTPUT"; then
    if [ $attempt -lt $MAX_RETRIES ]; then
      echo "=================================================="
      echo "WARNING: Network/timeout error detected"
      echo "Retrying..."
      echo "=================================================="
      continue
    fi
  fi
  
  break
done

rm -f "$BUILD_OUTPUT" "$FIFO"
exit $EXIT_CODE
`.trim();
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
          `set -e
echo "=== Cloning repository ==="
CLONE_URL="${cloneUrl}"
MASKED_URL="\${CLONE_URL//:\\/\\/x-access-token:*@/:\/\/x-access-token:***@}"
MASKED_URL="\${MASKED_URL//:\\/\\/ghs_*@/:\/\/***@}"
MASKED_URL="\${MASKED_URL//:\\/\\/ghp_*@/:\/\/***@}"
MASKED_URL="\${MASKED_URL//:\\/\\/github_pat_*@/:\/\/***@}"
echo "Repository: \$MASKED_URL"
echo "Branch: ${branch}"

GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "${branch}" "\$CLONE_URL" /workspace 2>&1 | sed -E 's/(x-access-token:|ghs_|ghp_|github_pat_)[^ @]*/***REDACTED***/g'

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
                // Wrap with cache error handling
                command: ['/bin/sh', '-c'],
                args: [this.generateBuildScriptWithCacheFallback(buildctlArgs)],
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

    console.log(`[ImageBuilder] Creating job ${jobName} in namespace ${this.builderNamespace}`, {
      imageName: fullImageName,
      repoUrl: this.sanitizeLogMessage(repoUrl),
      branch,
      dockerfilePath,
      buildType,
      initContainerCount: initContainers.length,
      hasCacheEnabled: this.s3CacheEnabled,
      envVarsCount: Object.keys(envVars).length,
    });

    try {
      const jobCreationResult = await batchApi.createNamespacedJob(this.builderNamespace, job);
      console.log(`[ImageBuilder] Job ${jobName} created successfully. UID: ${jobCreationResult.body.metadata?.uid}`);
      await this.appendLog(deploymentId, `Build job ${jobName} created successfully`);

      if (deploymentId) {
        const dep = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildStepTimestamps: true },
        });
        const ts = (dep?.buildStepTimestamps as Record<string, number> | null) || {};
        ts['building'] = Date.now();
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            buildStep: 'building',
            buildStepTimestamps: ts,
          },
        });
      }

      return jobName;
    } catch (error) {
      const errorDetails = error.body ? JSON.stringify(error.body, null, 2) : error.message;
      const errorMsg = `Failed to create build job: ${error.message}${error.body ? `\nDetails: ${errorDetails}` : ''}`;
      
      console.error('[ImageBuilder] Job creation failed:', {
        jobName,
        namespace: this.builderNamespace,
        error: error.message,
        statusCode: error.statusCode,
        errorBody: error.body,
        errorStack: error.stack,
      });
      
      await this.appendLog(deploymentId, errorMsg, 'ERROR');
      await this.appendLog(deploymentId, `Job creation error details: ${errorDetails}`, 'ERROR');
      
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

    // Add cache arguments (namespaced per image to prevent cross-deployment contamination)
    const cacheArgs = this.buildCacheArgs(fullImageName);
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

    const cacheArgs = this.buildCacheArgs(fullImageName);
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

      console.log(`[ImageBuilder] Job ${jobName} status:`, JSON.stringify({
        succeeded: jobSpec.status?.succeeded,
        failed: jobSpec.status?.failed,
        active: jobSpec.status?.active,
        conditions: jobSpec.status?.conditions,
        startTime: jobSpec.status?.startTime,
        completionTime: jobSpec.status?.completionTime,
      }));

      let status: BuildJobStatus['status'] = 'unknown';
      let logs = '';

      if (jobSpec.status?.succeeded && jobSpec.status.succeeded > 0) {
        status = 'succeeded';
      } else if (jobSpec.status?.failed && jobSpec.status.failed > 0) {
        status = 'failed';
        console.error(`[ImageBuilder] Job ${jobName} failed. Conditions:`, JSON.stringify(jobSpec.status?.conditions));
      } else if (jobSpec.status?.active && jobSpec.status.active > 0) {
        status = 'running';
      } else {
        status = 'pending';
      }

      try {
        const pods = await coreApi.listNamespacedPod(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `job-name=${jobName}`
        );

        console.log(`[ImageBuilder] Found ${pods.body.items.length} pods for job ${jobName}`);

        if (pods.body.items.length > 0) {
          const pod = pods.body.items[0];
          const podName = pod.metadata?.name;
          const podPhase = pod.status?.phase;
          const podConditions = pod.status?.conditions;
          const containerStatuses = pod.status?.containerStatuses;
          const initContainerStatuses = pod.status?.initContainerStatuses;

          console.log(`[ImageBuilder] Pod ${podName} details:`, JSON.stringify({
            phase: podPhase,
            conditions: podConditions,
            containerStatuses: containerStatuses?.map(cs => ({
              name: cs.name,
              ready: cs.ready,
              state: cs.state,
              lastState: cs.lastState,
            })),
            initContainerStatuses: initContainerStatuses?.map(ics => ({
              name: ics.name,
              ready: ics.ready,
              state: ics.state,
              lastState: ics.lastState,
            })),
          }));

          if (status === 'failed' || podPhase === 'Failed') {
            const failureReasons: string[] = [];
            
            if (containerStatuses) {
              for (const cs of containerStatuses) {
                if (cs.state?.terminated) {
                  failureReasons.push(`Container ${cs.name} terminated: ${cs.state.terminated.reason || 'Unknown'} - ${cs.state.terminated.message || 'No message'}`);
                  console.error(`[ImageBuilder] Container failure:`, JSON.stringify(cs.state.terminated));
                }
                if (cs.state?.waiting) {
                  failureReasons.push(`Container ${cs.name} waiting: ${cs.state.waiting.reason || 'Unknown'} - ${cs.state.waiting.message || 'No message'}`);
                  console.error(`[ImageBuilder] Container waiting:`, JSON.stringify(cs.state.waiting));
                }
              }
            }

            if (initContainerStatuses) {
              for (const ics of initContainerStatuses) {
                if (ics.state?.terminated && ics.state.terminated.exitCode !== 0) {
                  failureReasons.push(`Init container ${ics.name} failed with exit code ${ics.state.terminated.exitCode}: ${ics.state.terminated.reason || 'Unknown'} - ${ics.state.terminated.message || 'No message'}`);
                  console.error(`[ImageBuilder] Init container failure:`, JSON.stringify(ics.state.terminated));
                }
                if (ics.state?.waiting) {
                  failureReasons.push(`Init container ${ics.name} waiting: ${ics.state.waiting.reason || 'Unknown'} - ${ics.state.waiting.message || 'No message'}`);
                  console.error(`[ImageBuilder] Init container waiting:`, JSON.stringify(ics.state.waiting));
                }
              }
            }

            if (failureReasons.length > 0) {
              logs = `Build job failed with the following reasons:\n${failureReasons.join('\n')}\n\n`;
            }
          }

          if (podName) {
            try {
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
                5000
              );
              logs += logResponse.body;
            } catch (buildkitLogError) {
              console.warn(`[ImageBuilder] Could not fetch buildkit logs for pod ${podName}:`, buildkitLogError.message);
              
              try {
                const allContainerLogs: string[] = [];
                
                if (initContainerStatuses) {
                  for (const ics of initContainerStatuses) {
                    try {
                      const initLogResponse = await coreApi.readNamespacedPodLog(
                        podName,
                        this.builderNamespace,
                        ics.name,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        1000
                      );
                      allContainerLogs.push(`\n=== Init Container: ${ics.name} ===\n${initLogResponse.body}`);
                    } catch (initLogErr) {
                      console.warn(`[ImageBuilder] Could not fetch logs for init container ${ics.name}:`, initLogErr.message);
                    }
                  }
                }

                if (allContainerLogs.length > 0) {
                  logs += allContainerLogs.join('\n');
                }
              } catch (fallbackError) {
                console.error(`[ImageBuilder] Failed to fetch any container logs:`, fallbackError.message);
              }
            }
          }
        }
      } catch (logError) {
        console.error(`[ImageBuilder] Error fetching pod details for job ${jobName}:`, logError.message);
        if (logError.body) {
          console.error(`[ImageBuilder] Error body:`, JSON.stringify(logError.body));
        }
      }

      const imageRef = jobSpec.metadata?.annotations?.['orchard.dev/full-image'];

      return {
        jobName,
        status,
        logs,
        imageRef,
      };
    } catch (error) {
      if (error.statusCode === 404) {
        console.warn(`[ImageBuilder] Job ${jobName} not found (404)`);
        return {
          jobName,
          status: 'unknown',
          logs: 'Job not found',
        };
      }
      console.error(`[ImageBuilder] Error reading job ${jobName}:`, error.message);
      if (error.body) {
        console.error(`[ImageBuilder] Error body:`, JSON.stringify(error.body));
      }
      throw error;
    }
  }

  async waitForBuildJob(jobName: string, deploymentId?: string, timeoutMs: number = 1800000): Promise<BuildJobStatus> {
    const startTime = Date.now();
    const pollInterval = 5000;
    let lastLoggedStatus = '';
    let pollCount = 0;

    console.log(`[ImageBuilder] Starting to wait for build job ${jobName} (timeout: ${timeoutMs / 1000}s, deploymentId: ${deploymentId})`);
    await this.appendLog(deploymentId, `Waiting for build job ${jobName} to complete...`);

    while (Date.now() - startTime < timeoutMs) {
      pollCount++;
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      
      try {
        const status = await this.getBuildJobStatus(jobName);
        
        if (status.status !== lastLoggedStatus) {
          console.log(`[ImageBuilder] Job ${jobName} status changed: ${lastLoggedStatus} -> ${status.status} (poll #${pollCount}, elapsed: ${elapsedSeconds}s)`);
          lastLoggedStatus = status.status;
        }

        if (status.status === 'succeeded') {
          console.log(`[ImageBuilder] Build job ${jobName} completed successfully after ${elapsedSeconds}s`);
          await this.appendLog(deploymentId, `Build job ${jobName} completed successfully`);
          if (status.logs) {
            const logLines = status.logs.split('\n').slice(-50).join('\n');
            await this.appendLog(deploymentId, `Build output:\n${logLines}`);
          }
          return status;
        }

        if (status.status === 'failed') {
          const errorMsg = status.logs || 'Unknown error - no logs available';
          console.error(`[ImageBuilder] Build job ${jobName} failed after ${elapsedSeconds}s. Error: ${errorMsg.substring(0, 500)}`);
          await this.appendLog(deploymentId, `Build job ${jobName} failed`, 'ERROR');
          
          if (status.logs) {
            await this.appendLog(deploymentId, `Build failure details:\n${status.logs}`, 'ERROR');
          } else {
            await this.appendLog(deploymentId, 'No build logs available - this may indicate a pod scheduling or initialization failure', 'ERROR');
          }

          const detailedError = status.logs 
            ? `Build job failed: ${status.logs}` 
            : 'Build job failed: No logs available. This typically indicates a pod scheduling failure, image pull error, or init container failure. Check Kubernetes pod events for more details.';
          
          throw new BadRequestException(detailedError);
        }

        if (status.status === 'running' && status.logs) {
          const logLines = status.logs.split('\n');
          const recentLines = logLines.slice(-5).join('\n');
          if (recentLines.trim()) {
            await this.appendLog(deploymentId, `Build progress:\n${recentLines}`);
          }
        }

        if (status.status === 'pending' && elapsedSeconds > 60) {
          console.warn(`[ImageBuilder] Job ${jobName} still pending after ${elapsedSeconds}s - possible scheduling issue`);
          if (elapsedSeconds % 30 === 0) {
            await this.appendLog(deploymentId, `Build job still pending after ${elapsedSeconds}s - waiting for pod to be scheduled...`, 'WARNING');
          }
        }

      } catch (error) {
        console.error(`[ImageBuilder] Error polling build job ${jobName} status (poll #${pollCount}):`, error.message);
        if (error.body) {
          console.error(`[ImageBuilder] Error details:`, JSON.stringify(error.body));
        }
        
        if (error instanceof BadRequestException) {
          throw error;
        }
        
        await this.appendLog(deploymentId, `Warning: Error checking build status: ${error.message}`, 'WARNING');
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
    console.error(`[ImageBuilder] Build job ${jobName} timed out after ${finalElapsed}s (${pollCount} polls)`);
    await this.appendLog(deploymentId, `Build job ${jobName} timed out after ${finalElapsed}s`, 'ERROR');
    
    try {
      const finalStatus = await this.getBuildJobStatus(jobName);
      await this.appendLog(deploymentId, `Final status: ${finalStatus.status}`, 'ERROR');
      if (finalStatus.logs) {
        await this.appendLog(deploymentId, `Final logs:\n${finalStatus.logs}`, 'ERROR');
      }
    } catch (finalCheckError) {
      console.error(`[ImageBuilder] Could not fetch final status:`, finalCheckError.message);
    }
    
    throw new BadRequestException(`Build job timed out after ${finalElapsed} seconds (last status: ${lastLoggedStatus})`);
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

  async cancelBuildJobsByDeploymentId(deploymentId: string): Promise<void> {
    this.ensureKubeConfig();
    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    try {
      const labelSelector = `orchard.dev/deployment-id=${deploymentId}`;
      console.log(`[ImageBuilder] Looking for build jobs with label selector: ${labelSelector}`);

      const jobs = await batchApi.listNamespacedJob(
        this.builderNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
      );

      if (jobs.body.items.length === 0) {
        console.log(`[ImageBuilder] No build jobs found for deployment ${deploymentId}`);
        return;
      }

      console.log(`[ImageBuilder] Found ${jobs.body.items.length} build job(s) for deployment ${deploymentId}`);

      for (const job of jobs.body.items) {
        const jobName = job.metadata?.name;
        if (!jobName) continue;

        try {
          console.log(`[ImageBuilder] Deleting build job ${jobName} for deployment ${deploymentId}`);
          
          const pods = await coreApi.listNamespacedPod(
            this.builderNamespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `job-name=${jobName}`
          );

          for (const pod of pods.body.items) {
            const podName = pod.metadata?.name;
            if (podName) {
              console.log(`[ImageBuilder] Force deleting pod ${podName} for job ${jobName}`);
              try {
                await coreApi.deleteNamespacedPod(
                  podName,
                  this.builderNamespace,
                  undefined,
                  undefined,
                  0,
                  undefined,
                  'Background'
                );
              } catch (podDeleteError) {
                if (podDeleteError.statusCode !== 404) {
                  console.warn(`[ImageBuilder] Failed to delete pod ${podName}:`, podDeleteError.message);
                }
              }
            }
          }
          
          await batchApi.deleteNamespacedJob(
            jobName,
            this.builderNamespace,
            undefined,
            undefined,
            0,
            undefined,
            'Background',
            {
              propagationPolicy: 'Background'
            }
          );

          console.log(`[ImageBuilder] Successfully deleted build job ${jobName} and its pods`);
        } catch (deleteError) {
          if (deleteError.statusCode !== 404) {
            console.error(`[ImageBuilder] Failed to delete job ${jobName}:`, deleteError.message);
          }
        }
      }
    } catch (error) {
      console.error(`[ImageBuilder] Error cancelling build jobs for deployment ${deploymentId}:`, error.message);
      throw error;
    }
  }

  async buildAndPush(options: BuildJobOptions): Promise<string> {
    const { imageName, tag = 'latest', deploymentId, repoUrl, branch, buildType = 'dockerfile' } = options;

    console.log(`[ImageBuilder] buildAndPush called with:`, {
      imageName,
      tag,
      deploymentId,
      repoUrl,
      branch,
      dockerfilePath: options.dockerfilePath,
      buildType,
      target: options.target,
      buildFromRoot: options.buildFromRoot,
      hasAccessToken: !!options.accessToken,
      envVarsCount: Object.keys(options.envVars || {}).length,
    });

    try {
      await this.appendLog(deploymentId, `Starting BuildKit build for ${repoUrl}@${branch} (type: ${buildType})`);
      await this.setBuildStep(deploymentId, 'starting');

      const jobName = await this.createBuildJob(options);
      console.log(`[ImageBuilder] Created build job: ${jobName}`);

      const status = await this.waitForBuildJob(jobName, deploymentId);

      const fullImagePath = `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`;

      console.log(`[ImageBuilder] Build completed successfully: ${fullImagePath}`);
      await this.appendLog(deploymentId, `Build and push completed successfully!`);
      await this.appendLog(deploymentId, `Image available at: ${fullImagePath}`);
      await this.setBuildStep(deploymentId, 'completed');

      await this.deleteBuildJob(jobName);

      return fullImagePath;
    } catch (error) {
      const errorMsg = `Build failed: ${error.message}`;
      const errorStack = error.stack || 'No stack trace available';
      
      console.error('[ImageBuilder] Build failed:', {
        deploymentId,
        imageName,
        tag,
        error: errorMsg,
        stack: errorStack,
        errorType: error.constructor.name,
        statusCode: error.statusCode || error.status,
        responseBody: error.body || error.response,
      });

      await this.appendLog(deploymentId, errorMsg, 'ERROR');
      await this.appendLog(deploymentId, `Error type: ${error.constructor.name}`, 'ERROR');
      await this.setBuildStep(deploymentId, 'failed');

      if (deploymentId) {
        try {
          // Don't overwrite a successful build status from a newer build
          const currentDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildStatus: true },
          });
          if (currentDeployment?.buildStatus === 'succeeded') {
            console.log(`[ImageBuilder] Deployment ${deploymentId} already has a succeeded build (likely from a newer build), skipping error status update`);
          } else {
            await this.prisma.deployment.update({
              where: { id: deploymentId },
              data: {
                buildStatus: 'failed',
                buildError: error.message,
              },
            });
          }
        } catch (dbError) {
          console.error('[ImageBuilder] Failed to update deployment status:', dbError.message);
        }
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

  /**
   * Parse an image string (e.g. harbor.1mp.dev/orchard/namespace-name:tag)
   * and return the repo name (without project prefix) and tag.
   */
  private parseImageRef(image: string): { repoName: string; tag: string | null } {
    const tagIndex = image.lastIndexOf(':');
    const imagePath = tagIndex !== -1 ? image.substring(0, tagIndex) : image;
    const tag = tagIndex !== -1 ? image.substring(tagIndex + 1) : null;

    const registryPrefixes = [this.harborRegistryPush, this.harborRegistryPull];
    let repo = imagePath;
    for (const prefix of registryPrefixes) {
      if (repo.startsWith(prefix + '/')) {
        repo = repo.substring(prefix.length + 1);
        break;
      }
    }
    const repoName = repo.replace(`${this.harborProject}/`, '');
    return { repoName, tag };
  }

  private getHarborAuth(): { authHeader: string; registryUrl: string } | null {
    const harborUsername = process.env.HARBOR_USERNAME;
    const harborPassword = process.env.HARBOR_PASSWORD;
    if (!harborUsername || !harborPassword) {
      console.warn('[ImageBuilder] Harbor credentials not configured, skipping registry image deletion');
      return null;
    }
    const authHeader = 'Basic ' + Buffer.from(`${harborUsername}:${harborPassword}`).toString('base64');
    const registryUrl = this.harborRegistryPull.startsWith('http')
      ? this.harborRegistryPull
      : `https://${this.harborRegistryPull}`;
    return { authHeader, registryUrl };
  }

  /**
   * Delete a specific artifact (tag) from a Harbor repository.
   * Used when pruning old images while keeping the repository intact.
   */
  async deleteArtifactFromRegistry(image: string): Promise<void> {
    try {
      const { repoName, tag } = this.parseImageRef(image);
      if (!tag) {
        console.warn(`[ImageBuilder] Cannot delete artifact without tag: ${image}`);
        return;
      }

      const auth = this.getHarborAuth();
      if (!auth) return;

      const deleteUrl = `${auth.registryUrl}/api/v2.0/projects/${this.harborProject}/repositories/${encodeURIComponent(repoName)}/artifacts/${encodeURIComponent(tag)}`;

      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: { 'Authorization': auth.authHeader },
      });

      if (response.ok) {
        console.log(`[ImageBuilder] Deleted artifact from registry: ${this.harborProject}/${repoName}:${tag}`);
      } else if (response.status === 404) {
        console.warn(`[ImageBuilder] Artifact not found in registry (already deleted?): ${this.harborProject}/${repoName}:${tag}`);
      } else {
        const body = await response.text();
        console.error(`[ImageBuilder] Failed to delete artifact: ${this.harborProject}/${repoName}:${tag}, status: ${response.status}, body: ${body}`);
      }
    } catch (error) {
      console.error(`[ImageBuilder] Error deleting artifact from registry: ${image}`, error);
    }
  }

  /**
   * Delete an entire repository from Harbor.
   * Used when a deployment is fully deleted and all images should be removed.
   */
  async deleteRepositoryFromRegistry(image: string): Promise<void> {
    try {
      const { repoName } = this.parseImageRef(image);

      const auth = this.getHarborAuth();
      if (!auth) return;

      const deleteUrl = `${auth.registryUrl}/api/v2.0/projects/${this.harborProject}/repositories/${encodeURIComponent(repoName)}`;

      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: { 'Authorization': auth.authHeader },
      });

      if (response.ok) {
        console.log(`[ImageBuilder] Deleted repository from registry: ${this.harborProject}/${repoName}`);
      } else if (response.status === 404) {
        console.warn(`[ImageBuilder] Repository not found in registry (already deleted?): ${this.harborProject}/${repoName}`);
      } else {
        const body = await response.text();
        console.error(`[ImageBuilder] Failed to delete repository: ${this.harborProject}/${repoName}, status: ${response.status}, body: ${body}`);
      }
    } catch (error) {
      console.error(`[ImageBuilder] Error deleting repository from registry: ${image}`, error);
    }
  }

  /**
   * Delete specific artifacts (tags) from Harbor.
   */
  async deleteArtifactsFromRegistry(images: string[]): Promise<void> {
    for (const image of images) {
      await this.deleteArtifactFromRegistry(image);
    }
  }

  /**
   * Delete entire repositories from Harbor.
   * Deduplicates by repo name so the same repository isn't deleted multiple times.
   */
  async deleteRepositoriesFromRegistry(images: string[]): Promise<void> {
    const seenRepos = new Set<string>();
    for (const image of images) {
      const { repoName } = this.parseImageRef(image);
      if (!seenRepos.has(repoName)) {
        seenRepos.add(repoName);
        await this.deleteRepositoryFromRegistry(image);
      }
    }
  }
}
