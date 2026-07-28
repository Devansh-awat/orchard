import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BuildKitPoolService } from './buildkit-pool.service';
import { OrgEventsService } from '../events/org-events.service';
import { startPhaseSpan, recordPhaseSpan } from '../analytics/datadog';
import { truncateK8sName } from '../projects/projects.utils';
import {
  RAILPACK_INFO_MARKER,
  ORCHARD_RAILPACK_CONFIG,
  parseRailpackInfo,
  railpackConfigOverride,
} from './build-config';

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
  /**
   * Repo-relative directory of the app for Railpack builds. Already validated
   * by normalizeRootDirectory before it reaches here — it is interpolated into
   * the prepare container's shell script.
   */
  rootDirectory?: string | null;
  envVars?: Record<string, string>;
  buildWithDepot?: boolean;
  // Presigned GET URL for an uploaded build-context tarball ("orchard up").
  // When set, the git-clone init container is replaced by a fetch-and-extract
  // step; everything downstream (BuildKit, phases, log streaming) is
  // unchanged.
  localContextUrl?: string;
  // Per-tenant key used as the subPath on the shared buildkit-cache PVC.
  // Without this, every build pod sees the entire PVC and a malicious build
  // (root inside the Kata VM) can read/poison cache entries from other
  // tenants. With subPath, the Kata mount surface only exposes this tenant's
  // slice. Set to the project namespace by the caller.
  cacheTenantKey?: string;
  // When true, builds connect to a persistent BuildKit daemon pod (managed
  // by BuildKitPoolService) instead of running buildctl-daemonless.sh in
  // each Job. The daemon keeps its layer cache warm between builds, so
  // unchanged layers are instant cache hits (like Depot).
  persistentBuildCache?: boolean;
  disableSharedCache?: boolean;
}

interface BuildJobStatus {
  jobName: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  logs?: string;
  pusherLogs?: string;
  imageRef?: string;
  /** Raw railpack-info.json line, when the prepare init container produced one. */
  railpackInfoLog?: string;
}

const BUILDKIT_PUSH_PHASE_RE =
  /exporting to [^\n]*image|exporting layers|sending tarball|pushing manifest/i;

const BUILDKIT_STEP_RE = /(?:^|\n)#\d+\s/;

@Injectable()
export class ImageBuilderService {
  private kc: k8s.KubeConfig | null = null;

  private buildkitLogOffsets = new Map<string, number>();

  private buildkitPushDetected = new Set<string>();

  private buildkitBuildingDetected = new Set<string>();

  private railpackInfoFetched = new Set<string>();

  private readonly builderNamespace = process.env.BUILDER_NAMESPACE || 'orchard-builders';

  // Internal Harbor registry for pushing (HTTP on port 80)
  private readonly harborRegistryPush = process.env.DOCKER_REGISTRY_PUSH || 'harbor-core.harbor.svc.cluster.local';

  private readonly harborRegistryPull = process.env.DOCKER_REGISTRY_PULL || 'harbor.1mp.dev';

  private readonly harborProject = process.env.REGISTRY_PROJECT || 'orchard';

  private readonly registrySecretName = process.env.REGISTRY_PULL_SECRET_NAME || 'harbor-registry-creds';

  // Depot configuration
  private readonly depotToken = process.env.DEPOT_TOKEN;

  private readonly depotProjectId = process.env.DEPOT_PROJECT_ID;

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

  // Local cache configuration — when enabled, overrides S3 cache and uses a
  // path inside the build pod (optionally backed by a PVC for persistence).
  private readonly localCacheEnabled = process.env.BUILDKIT_LOCAL_CACHE_ENABLED === 'true';

  private readonly buildkitImage = process.env.BUILDKIT_IMAGE || 'moby/buildkit:v0.31.1';

  // Railpack ships three artefacts on independent version lines: the CLI that
  // writes the plan, the BuildKit gateway frontend that executes it, and the
  // mise base image the prepare step runs in. They all used to float on
  // `latest`, so a Railway release could change every Orchard build with no
  // deploy on our side — and a CLI/frontend plan-schema mismatch would break
  // builds outright. Pin them together; bump deliberately.
  private readonly railpackVersion = process.env.RAILPACK_VERSION || 'v0.33.0';

  private readonly railpackFrontendImage =
    process.env.RAILPACK_FRONTEND_IMAGE || `ghcr.io/railwayapp/railpack-frontend:${process.env.RAILPACK_VERSION || 'v0.33.0'}`;

  private readonly railpackMiseImage =
    process.env.RAILPACK_MISE_IMAGE || 'ghcr.io/railwayapp/railpack-mise:20260227';

  private readonly localCachePath = process.env.BUILDKIT_LOCAL_CACHE_PATH || '/cache/buildkit';

  private readonly localCachePvc = process.env.BUILDKIT_LOCAL_CACHE_PVC;

  // When enabled, build jobs are pinned to nodes labelled `orchard-builder=true`
  // (and tolerate a matching `orchard-builder` NoSchedule taint if present).
  private readonly dedicatedNodeEnabled = process.env.BUILDER_DEDICATED_NODE === 'true';

  // Sandboxing toggles — both default off so prior versions behave identically.
  //   BUILDER_RUNTIME_CLASS: if set (e.g. "kata"), the build Job pod selects
  //     that RuntimeClass. With Kata each pod gets its own lightweight VM, so
  //     the privileged BuildKit container is privileged-in-VM, not on host.
  //   BUILDER_SIDECAR_PUSH: if "true", the BuildKit container runs as an
  //     init container with NO Harbor push creds mounted; a tiny `crane`
  //     pusher container runs after it (as the Job's main container) with
  //     the creds and pushes the OCI tarball BuildKit wrote to /output.
  //     Defence-in-depth against a malicious Dockerfile / BuildKit RCE
  //     exfiltrating `/root/.docker/config.json`.
  private readonly builderRuntimeClass = (process.env.BUILDER_RUNTIME_CLASS || '').trim() || undefined;

  private readonly sidecarPushEnabled = process.env.BUILDER_SIDECAR_PUSH === 'true';

  private readonly pusherImage =
    process.env.BUILDER_PUSHER_IMAGE || 'gcr.io/go-containerregistry/crane:latest';

  private readonly workspaceTmpfs = process.env.BUILDER_WORKSPACE_TMPFS === 'true';

  private readonly scratchMode = (process.env.BUILDER_SCRATCH_MODE || 'tmpfs').trim();

  private readonly scratchBlock = this.scratchMode === 'block';

  private readonly scratchSize = process.env.BUILDER_SCRATCH_SIZE || '40Gi';

  private readonly scratchStorageClass = process.env.BUILDER_SCRATCH_STORAGE_CLASS || 'longhorn-ssd';

  private static readonly SCRATCH_DEVICE = '/dev/buildscratch';

  private builderInfraReady = false;

  private deploymentOrgCache = new Map<string, { orgId: string; projectId: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    @Optional() private readonly buildKitPool?: BuildKitPoolService,
  ) {
    this.initKubeConfig();
  }

  private async emitBuildChanged(deploymentId: string | undefined) {
    if (!deploymentId) return;
    let ctx = this.deploymentOrgCache.get(deploymentId);
    if (!ctx) {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { projectId: true, project: { select: { organizationId: true } } },
      });
      if (!dep) return;
      ctx = { orgId: dep.project.organizationId, projectId: dep.projectId };
      this.deploymentOrgCache.set(deploymentId, ctx);
    }
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'build.changed',
      id: deploymentId,
      projectId: ctx.projectId,
    });
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

  /**
   * Distill a failed build's log dump into the few lines a user needs. The
   * full logs already stream into buildLogs; buildError must stay short
   * because the UI surfaces it as the headline failure reason.
   */
  private summarizeBuildFailure(logs?: string | null, pusherLogs?: string | null): string {
    const parts: string[] = [];

    const lintMatch = (logs ?? '').match(/lint violation found for rules: ([A-Za-z0-9, ]+)/);
    if (lintMatch) {
      const rules = lintMatch[1].trim();
      parts.push(
        `Dockerfile lint check failed (${rules}). Your Dockerfile sets "# check=error=true", which turns Dockerfile lint warnings into build failures. Remove that line, or change it to "# check=skip=${rules.replace(/,\s*/g, ',')}" to skip these rules.`,
      );
    }

    const lines = (logs ?? '').split('\n');
    const solveError = lines.filter((l) => l.startsWith('error: failed to solve:')).pop();
    const stepErrors = lines.filter((l) => /^#\d+ ERROR:/.test(l)).slice(-2);
    parts.push(...stepErrors);
    if (solveError && !stepErrors.some((e) => solveError.includes(e.replace(/^#\d+ ERROR: /, '')))) {
      parts.push(solveError);
    }

    const reasonsMatch = (logs ?? '').match(
      /Build job failed with the following reasons:\n([\s\S]*?)(?:\n\n|$)/,
    );
    if (reasonsMatch) {
      parts.push(
        ...reasonsMatch[1]
          .split('\n')
          .filter((l) => l.trim() && !/ - No message$/.test(l)),
      );
    }

    const pusherError = (pusherLogs ?? '')
      .split('\n')
      .filter((l) => /^(FATA|Error)\b|level=fatal/.test(l))
      .pop();
    if (pusherError) parts.push(`Pusher: ${pusherError}`);

    if (parts.length === 0) {
      const tail = lines.filter((l) => l.trim() && !l.startsWith('time=')).slice(-4);
      parts.push(...tail);
    }

    const seen = new Set<string>();
    const unique = parts.filter((p) => {
      const key = p.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return unique.join('\n').slice(0, 800);
  }

  private generateJobName(imageName: string): string {
    const hash = crypto.randomBytes(4).toString('hex');
    const sanitized = truncateK8sName(
      imageName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, ''),
      40,
    );
    return `image-builder-${sanitized || 'image'}-${hash}`;
  }

  private sanitizeLogMessage(message: string): string {
    let sanitized = message;

    sanitized = sanitized.replace(/(x-access-token:|ghs_|ghp_|github_pat_)[a-zA-Z0-9_]+/gi, '***REDACTED***');

    sanitized = sanitized.replace(/https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi, 'https://***@github.com');

    sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');

    sanitized = sanitized.replace(/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-.]+/gi, '$1 ***REDACTED***');

    sanitized = sanitized.replace(/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi, '$1=***REDACTED***');

    // Redact internal registry hostnames so the registry URL never leaks into user-visible logs.
    const registryHosts = new Set<string>();
    for (const reg of [this.harborRegistryPush, this.harborRegistryPull]) {
      if (!reg) continue;
      const host = reg.replace(/^https?:\/\//, '').split('/')[0];
      if (host) registryHosts.add(host);
    }
    for (const host of registryHosts) {
      const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(escaped, 'g'), '***registry***');
    }

    return sanitized;
  }

  private async appendLog(deploymentId: string | undefined, message: string, level: 'INFO' | 'ERROR' | 'WARNING' = 'INFO') {
    if (!deploymentId) return;

    try {
      const timestamp = Date.now();
      const sanitizedMessage = this.sanitizeLogMessage(message);
      const line = `[${timestamp}] [${level}] ${sanitizedMessage}\n`;

      await this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || ${line},
            "updated_at" = NOW()
        WHERE "id" = ${deploymentId}::uuid
      `;
    } catch (error) {
      console.error('[ImageBuilder] Failed to append log:', error);
    }
  }

  // Stream raw BuildKit pod output into deployment.buildLogs, appending only
  // the new chunk since last poll (so the frontend can parse the full #N step
  // history). Tracks offset per job so re-polling the full pod log doesn't
  // duplicate content.
  private async streamBuildkitOutput(deploymentId: string | undefined, jobName: string, fullLogs: string | undefined) {
    if (!deploymentId || !fullLogs) return;
    const chunk = this.takeLogChunk(jobName, fullLogs);
    if (chunk === null) return;

    await this.appendStreamedChunk(deploymentId, chunk, jobName, fullLogs.length);

    if (!this.buildkitBuildingDetected.has(jobName) && BUILDKIT_STEP_RE.test(chunk)) {
      this.buildkitBuildingDetected.add(jobName);
      await this.setBuildStep(deploymentId, 'building');
    }

    if (!this.buildkitPushDetected.has(jobName) && BUILDKIT_PUSH_PHASE_RE.test(chunk)) {
      this.buildkitPushDetected.add(jobName);
      await this.setBuildStep(deploymentId, 'pushing');
    }

    this.emitBuildChanged(deploymentId).catch(() => {});
  }

  private async streamPusherOutput(deploymentId: string | undefined, jobName: string, pusherLogs: string | undefined) {
    if (!deploymentId || !pusherLogs) return;
    const chunk = this.takeLogChunk(`${jobName}:pusher`, pusherLogs);
    if (chunk === null) return;
    await this.appendStreamedChunk(deploymentId, chunk, `${jobName}:pusher`, pusherLogs.length);
    this.emitBuildChanged(deploymentId).catch(() => {});
  }

  private async seedLogOffsets(jobName: string, deploymentId?: string) {
    if (!deploymentId || this.buildkitLogOffsets.has(jobName)) return;
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStepTimestamps: true },
      });
      const offsets = ((deployment?.buildStepTimestamps as Record<string, any>)?.__logOffsets ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(offsets)) {
        if (key !== jobName && !key.startsWith(`${jobName}:`)) continue;
        if (typeof value === 'number' && !this.buildkitLogOffsets.has(key)) {
          this.buildkitLogOffsets.set(key, value);
        }
      }
    } catch {
      return;
    }
  }

  private takeLogChunk(offsetKey: string, fullLogs: string): string | null {
    const offset = this.buildkitLogOffsets.get(offsetKey) ?? 0;
    if (fullLogs.length <= offset) return null;
    this.buildkitLogOffsets.set(offsetKey, fullLogs.length);
    return fullLogs.slice(offset);
  }

  private async appendStreamedChunk(deploymentId: string, chunk: string, offsetKey?: string, offsetValue?: number) {
    try {
      const sanitized = this.sanitizeLogMessage(chunk);
      if (offsetKey !== undefined && offsetValue !== undefined) {
        await this.prisma.$executeRaw`
          UPDATE "deployments"
          SET "build_logs" = CASE
            WHEN "build_logs" IS NULL OR "build_logs" = '' THEN ${sanitized}
            WHEN RIGHT("build_logs", 1) = E'\n' THEN "build_logs" || ${sanitized}
            ELSE "build_logs" || E'\n' || ${sanitized}
          END,
          "build_step_timestamps" = jsonb_set(
            jsonb_set(
              COALESCE("build_step_timestamps", '{}'::jsonb),
              '{__logOffsets}',
              COALESCE("build_step_timestamps"->'__logOffsets', '{}'::jsonb),
              true
            ),
            ARRAY['__logOffsets', ${offsetKey}],
            to_jsonb(${offsetValue}::bigint),
            true
          ),
          "updated_at" = NOW()
          WHERE "id" = ${deploymentId}::uuid
        `;
        return;
      }
      await this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = CASE
          WHEN "build_logs" IS NULL OR "build_logs" = '' THEN ${sanitized}
          WHEN RIGHT("build_logs", 1) = E'\n' THEN "build_logs" || ${sanitized}
          ELSE "build_logs" || E'\n' || ${sanitized}
        END,
        "updated_at" = NOW()
        WHERE "id" = ${deploymentId}::uuid
      `;
    } catch (error) {
      console.error('[ImageBuilder] Failed to stream pod output:', error);
    }
  }

  private clearBuildkitOffset(jobName: string) {
    this.buildkitLogOffsets.delete(jobName);
    this.buildkitLogOffsets.delete(`${jobName}:pusher`);
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

    const registrySecretName = this.registrySecretName;
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
    const httpRegistries = new Set<string>(
      (process.env.REGISTRY_HTTP_HOSTS || 'harbor-core.harbor.svc.cluster.local,178.156.144.127')
        .split(',')
        .filter(Boolean),
    );

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
  gc = true
  gckeepstorage = 35000000000

  [[worker.oci.rlimits]]
    type = "RLIMIT_NOFILE"
    soft = 1048576
    hard = 1048576

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
    if (this.localCacheEnabled) {
      const sub = imageName ? imageName.replace(/[^a-z0-9-]/gi, '-') : 'default';
      const cacheDir = `${this.localCachePath}/${sub}`;
      console.log(`[ImageBuilder] Local cache enabled - path: ${cacheDir}`);
      const importCache = `type=local,src=${cacheDir}`;
      const exportCache = `type=local,dest=${cacheDir},mode=max,compression=zstd,ignore-error=true`;
      return [
        '--import-cache', importCache,
        '--export-cache', exportCache,
      ];
    }

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

  private createDepotContainer(opts: {
    dockerfilePath: string;
    fullImageName: string;
    target?: string;
    buildFromRoot: boolean;
    buildType: string;
    envVars: Record<string, string>;
  }): k8s.V1Container {
    const { dockerfilePath, fullImageName, target, buildFromRoot, buildType, envVars } = opts;

    // Keys are interpolated into the depot build shell string below. Reject
    // anything that isn't a POSIX identifier — same rule applied elsewhere
    // in this service and in projects.service.
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of Object.keys(envVars)) {
      if (!ENV_KEY_RE.test(key)) {
        throw new BadRequestException(`Invalid environment variable key: ${key}`);
      }
    }

    // Depot has never actually supported Railpack here: this branch used to
    // point at a plain `Dockerfile`, but the Railpack path writes a BuildKit
    // frontend plan (`railpack-plan.json`) and no Dockerfile ever exists, so
    // the build failed deep inside depot with a confusing "not found". Fail
    // fast with something actionable instead.
    if (buildType === 'railpack') {
      throw new BadRequestException(
        'Super builds do not support automatic (Railpack) builds yet. Turn off super builds for this app, or switch it to a Dockerfile build.',
      );
    }

    // Determine context directory and dockerfile flag
    let contextDir = '.';
    let dockerfileFlag = dockerfilePath;

    if (!buildFromRoot && dockerfilePath.includes('/')) {
      contextDir = dockerfilePath.substring(0, dockerfilePath.lastIndexOf('/'));
      dockerfileFlag = dockerfilePath.substring(dockerfilePath.lastIndexOf('/') + 1);
    }

    // Build the depot build command parts safely
    const buildArgLines = Object.entries(envVars)
      .map(([key]) => `--build-arg "${key}=\${${key}}"`)
      .join(' ');

    // Same lint behavior as the BuildKit path: without this, a repo's
    // "# check=error=true" directive fails depot builds that pass locally.
    const checkArgLine = 'BUILDKIT_DOCKERFILE_CHECK' in envVars
      ? ''
      : '--build-arg "BUILDKIT_DOCKERFILE_CHECK=skip=SecretsUsedInArgOrEnv"';

    const targetFlag = target ? `--target "${target}"` : '';

    const injectGitSha = buildType !== 'railpack' && !('GIT_SHA' in envVars);
    const gitShaArgLine = injectGitSha ? '--build-arg "GIT_SHA=$GIT_SHA"' : '';

    const depotScript = `set -e
GIT_SHA=$(git -C /workspace rev-parse HEAD 2>/dev/null || echo unknown)
echo "=== Installing Super Build tools ==="
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl
fi
curl -fsSL https://depot.dev/install-cli.sh | sh
export PATH="/root/.depot/bin:$PATH"
command -v depot >/dev/null 2>&1 || { echo "ERROR: Super Build CLI install failed"; exit 1; }

REGISTRY_AUTH=$(echo -n "$REGISTRY_USER:$REGISTRY_PASS" | base64)
mkdir -p /tmp/.docker
cat > /tmp/.docker/config.json << EOF
{"auths":{"$REGISTRY_HOST":{"username":"$REGISTRY_USER","password":"$REGISTRY_PASS","auth":"$REGISTRY_AUTH"}}}
EOF
export DOCKER_CONFIG=/tmp/.docker

echo "=== Building with Super Builds ==="
echo 0 > /tmp/build_rc
{ depot build \\
  --platform linux/amd64 \\
  -f "${dockerfileFlag}" \\
  -t "${fullImageName}" \\
  --push \\
  ${targetFlag} \\
  ${checkArgLine} \\
  ${gitShaArgLine} \\
  ${buildArgLines} \\
  "${contextDir}" 2>&1 || echo "$?" > /tmp/build_rc; } | sed -e 's/\\[depot\\]/[super-build]/gi' -e 's|https://depot\\.dev/[^ ]*||g' -e 's/depot build/super build/gi'
BUILD_RC=$(cat /tmp/build_rc)
if [ "$BUILD_RC" -ne 0 ]; then
  echo "=== Super Build failed (exit code $BUILD_RC) ==="
  exit "$BUILD_RC"
fi

echo "=== Super Build completed ==="
`;

    return {
      name: 'depot-build',
      image: 'buildpack-deps:bookworm-curl',
      command: ['/bin/sh', '-c'],
      args: [depotScript],
      workingDir: '/workspace',
      env: [
        { name: 'DEPOT_TOKEN', value: this.depotToken || '' },
        ...(this.depotProjectId ? [{ name: 'DEPOT_PROJECT_ID', value: this.depotProjectId }] : []),
        { name: 'REGISTRY_HOST', value: this.harborRegistryPush },
        { name: 'REGISTRY_USER', value: process.env.HARBOR_USERNAME || 'admin' },
        { name: 'REGISTRY_PASS', value: process.env.HARBOR_PASSWORD || '' },
        // Pass env vars so build-args can reference them via ${KEY}
        ...Object.entries(envVars).map(([key, value]) => ({
          name: key,
          value,
        })),
      ],
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
    };
  }

  private readonly ramdiskPreamble: string = '';

  private get scratchMountPreamble(): string {
    if (!this.scratchBlock) return '';
    const dev = ImageBuilderService.SCRATCH_DEVICE;
    return `
if ! mountpoint -q /buildkit-state 2>/dev/null; then
  mkdir -p /buildkit-state
  for _i in $(seq 1 20); do [ -b ${dev} ] && [ "$(blockdev --getsize64 ${dev} 2>/dev/null)" -gt 0 ] 2>/dev/null && break; sleep 0.25; done
  if [ -b ${dev} ]; then
    command -v mkfs.ext4 >/dev/null 2>&1 || apk add --no-cache e2fsprogs >/dev/null 2>&1
    mkfs.ext4 -q -F -E lazy_itable_init=1 ${dev} && sync
    for _i in 1 2 3 4 5; do mount ${dev} /buildkit-state 2>/dev/null && break; sleep 0.5; done
    if mountpoint -q /buildkit-state; then
      echo "=== Build scratch mounted on a dedicated disk ($(df -h /buildkit-state | awk 'NR==2{print $2}')) ==="
    else
      echo "WARNING: build scratch device present but mount failed; using container filesystem"
    fi
  else
    echo "WARNING: build scratch device ${dev} not present; using container filesystem"
  fi
fi
`;
  }

  /**
   * Generate a shell snippet that prunes the local cache directory when disk
   * usage exceeds 80%. Removes the oldest idle subdirectories (by mtime) until
   * usage drops below 70%.
   */
  private cachePrunePreamble(selfCacheDir = ''): string {
    if (!this.localCacheEnabled) return '';
    return `
# --- Prune local build cache if disk is getting full ---
CACHE_ROOT="${this.localCachePath}"
CACHE_SELF="${selfCacheDir}"
if [ -d "$CACHE_ROOT" ]; then
  USAGE=$(df "$CACHE_ROOT" | awk 'NR==2 {sub(/%/,"",$5); print $5}')
  if [ "$USAGE" -gt 80 ] 2>/dev/null; then
    echo "=== Cache disk usage at \${USAGE}% — pruning oldest idle entries ==="
    ls -1dt "$CACHE_ROOT"/*/ 2>/dev/null | tac | while read -r dir; do
      [ -d "$dir" ] || continue
      [ -n "$CACHE_SELF" ] && [ "\${dir%/}" = "\${CACHE_SELF%/}" ] && continue
      if find "$dir" -maxdepth 1 -mmin -30 2>/dev/null | grep -q .; then continue; fi
      USAGE=$(df "$CACHE_ROOT" | awk 'NR==2 {sub(/%/,"",$5); print $5}')
      if [ "$USAGE" -le 70 ]; then
        echo "=== Cache pruned down to \${USAGE}% ==="
        break
      fi
      echo "Removing idle cache: $dir"
      rm -rf "$dir"
    done
    USAGE=$(df "$CACHE_ROOT" | awk 'NR==2 {sub(/%/,"",$5); print $5}')
    if [ "$USAGE" -gt 80 ] 2>/dev/null; then
      echo "=== WARNING: cache disk still at \${USAGE}%; every remaining entry is in use or is ours. Continuing without pruning further ==="
    fi
  fi
fi
# --- End cache prune ---
`;
  }

  private static readonly GIT_SHA_PREAMBLE =
    'GIT_SHA=$(git -C /workspace rev-parse HEAD 2>/dev/null || echo unknown)\n';
  private static readonly GIT_SHA_BUILDCTL_OPT = ' --opt build-arg:GIT_SHA="$GIT_SHA"';

  /**
   * The railpack-prepare init container picks the directory the plan was
   * generated for (the repo root, or an app subdirectory outside a workspace)
   * and leaves it here. BuildKit's `--local context=.` has to resolve against
   * that same directory, and workingDir is fixed in the pod spec long before
   * the repository has been cloned. Dockerfile builds never write the file and
   * stay at /workspace.
   */
  private static readonly BUILD_DIR_PREAMBLE = `
if [ -f /workspace/.orchard-build-dir ]; then
  cd "$(cat /workspace/.orchard-build-dir)" || exit 1
  echo "=== Building in $(pwd) ==="
fi
`;

  private generateBuildScriptWithCacheFallback(buildctlArgs: string[], injectGitSha = false): string {
    const cacheArgs = this.buildCacheArgs();
    const hasCacheEnabled = cacheArgs.length > 0;

    const shellQuote = (arg: string) =>
      /^[A-Za-z0-9_\-./:=@,+%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

    const gitShaPreamble = injectGitSha ? ImageBuilderService.GIT_SHA_PREAMBLE : '';
    const gitShaOpt = injectGitSha ? ImageBuilderService.GIT_SHA_BUILDCTL_OPT : '';

    const argsWithCache = buildctlArgs.map(shellQuote).join(' ') + gitShaOpt;

    const buildDirPreamble = ImageBuilderService.BUILD_DIR_PREAMBLE;

    if (!hasCacheEnabled) {
      return gitShaPreamble + buildDirPreamble
        + this.generateRetryScript(`buildctl-daemonless.sh ${argsWithCache}`);
    }

    // Extract local cache dest dir from --export-cache arg so we can mkdir -p it
    const exportArg = buildctlArgs.find((_, i) => i > 0 && buildctlArgs[i - 1] === '--export-cache') || '';
    const destMatch = exportArg.match(/dest=([^,]+)/);
    const mkdirLine = destMatch ? `mkdir -p "${destMatch[1]}"` : '';

    const argsWithoutCache = buildctlArgs.filter((arg, idx, arr) => {
      if (arg === '--import-cache' || arg === '--export-cache') {
        return false;
      }
      if (idx > 0 && (arr[idx - 1] === '--import-cache' || arr[idx - 1] === '--export-cache')) {
        return false;
      }
      return true;
    }).map(shellQuote).join(' ') + gitShaOpt;

    const stateRoot = this.workspaceTmpfs ? '/buildkit-state' : '/var/lib/buildkit';

    const stateClearing = this.scratchBlock ? '' : `
  if [ -d "${stateRoot}" ]; then
    if command -v pgrep >/dev/null 2>&1; then
      for _i in $(seq 1 30); do
        pgrep buildkitd >/dev/null 2>&1 || break
        [ "$_i" = 1 ] && echo "=== Waiting for buildkitd to exit before clearing build state ==="
        pkill -TERM buildkitd 2>/dev/null || true
        sleep 1
      done
      pgrep buildkitd >/dev/null 2>&1 && pkill -KILL buildkitd 2>/dev/null && sleep 1
    fi
    echo "=== Clearing build state before no-cache retry ==="
    rm -rf "${stateRoot}"/* "${stateRoot}"/.[!.]* 2>/dev/null || true
  fi
`;

    return `
set +e
${gitShaPreamble}${buildDirPreamble}
ulimit -n 1048576 2>/dev/null || true
${this.ramdiskPreamble}${this.scratchMountPreamble}${this.cachePrunePreamble(destMatch?.[1] ?? '')}
${mkdirLine}
echo "=== Attempting build with cache enabled ==="
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

if grep -v "skipped due to err" "$BUILD_OUTPUT" | grep -qi "failed to check file presence in cache\\|operation error S3\\|api error BadRequest\\|no space left on device"; then
  echo "=================================================="
  echo "WARNING: Cache operation failed (S3 error or disk full)"
  echo "Failed to save/load cache - skipping cache"
  echo "Retrying without cache..."
  echo "=================================================="
  
  rm -f "$BUILD_OUTPUT"
  BUILD_OUTPUT=$(mktemp)
  FIFO=$(mktemp -u)
  mkfifo "$FIFO"

${stateClearing}
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
ulimit -n 1048576 2>/dev/null || true
${this.ramdiskPreamble}${this.scratchMountPreamble}${this.cachePrunePreamble()}
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
      rootDirectory,
      envVars = {},
      buildWithDepot = false,
      cacheTenantKey,
      persistentBuildCache = false,
      localContextUrl,
    } = options;

    // Sanitize the tenant key for use as a PVC subPath. Anything outside
    // [a-z0-9-] gets squashed; missing key collapses to "_shared" which is
    // the legacy behaviour (every build in one directory) — only used when
    // a caller hasn't been updated yet. New callers must pass this.
    const cacheSubPath = cacheTenantKey
      ? cacheTenantKey.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63) || '_shared'
      : '_shared';

    if (!this.builderInfraReady) {
      await this.ensureBuilderNamespace();
      await Promise.all([this.ensureBuilderSecrets(), this.ensureServiceAccount()]);
      this.builderInfraReady = true;
    }

    const jobName = this.generateJobName(imageName);
    const fullImageName = `${this.harborRegistryPush}/${this.harborProject}/${imageName}:${tag}`;

    const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    const builderLabel = buildWithDepot ? 'Super Builds' : 'BuildKit';
    this.appendLog(deploymentId, `Creating image-builder pod: ${jobName} (${buildMethodLabel} via ${builderLabel})`).catch(() => {});

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

    // Build the buildctl args. When using a persistent daemon, skip external
    // cache args — the daemon's own content store is the cache.
    const buildctlArgs = this.generateBuildctlArgs({
      dockerfilePath,
      fullImageName,
      target,
      buildFromRoot,
      buildType,
      envVars,
      secretsHash,
      cacheKey,
      skipCache: persistentBuildCache && !!this.buildKitPool,
    });

    const injectGitSha = buildType !== 'railpack' && !('GIT_SHA' in envVars);

    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);

    // Build init containers list. Local-upload builds fetch the uploaded
    // tarball via a short-lived presigned URL instead of cloning; the URL is
    // passed as an env var so it never appears in the pod command (visible to
    // anyone who can read the pod spec).
    const sourceInit: k8s.V1Container = localContextUrl
      ? {
          name: 'context-fetch',
          image: 'alpine:latest',
          command: ['/bin/sh', '-c'],
          args: [
            `set -e
echo "=== Fetching uploaded build context ==="
wget -qO /tmp/context.tar.gz "$CONTEXT_URL"
mkdir -p /workspace
tar xzf /tmp/context.tar.gz -C /workspace
rm -f /tmp/context.tar.gz
echo "=== Build context extracted ==="
ls -la /workspace
`,
          ],
          env: [{ name: 'CONTEXT_URL', value: localContextUrl }],
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
        }
      : {
        name: 'git-clone',
        image: 'alpine/git:latest',
        command: ['/bin/sh', '-c'],
        args: [
          `set -e
echo "=== Cloning repository ==="
CLONE_URL="${cloneUrl}"
MASKED_URL="\${CLONE_URL//:\\/\\/x-access-token:*@/://x-access-token:***@}"
MASKED_URL="\${MASKED_URL//:\\/\\/ghs_*@/://***@}"
MASKED_URL="\${MASKED_URL//:\\/\\/ghp_*@/://***@}"
MASKED_URL="\${MASKED_URL//:\\/\\/github_pat_*@/://***@}"
echo "Repository: $MASKED_URL"
echo "Branch: ${branch}"

# Enable git-lfs (best-effort) so LFS-tracked files are materialized instead of
# left as pointer stubs. alpine/git doesn't bundle it; install registers the
# global smudge filter so the clone below pulls LFS content during checkout.
if apk add --no-cache git-lfs >/dev/null 2>&1 && git lfs install --skip-repo >/dev/null 2>&1; then
  echo "git-lfs: enabled"
else
  echo "git-lfs: unavailable, continuing without it"
fi

CLONE_OUTPUT=$(GIT_TERMINAL_PROMPT=0 git clone --depth 1 --recurse-submodules --shallow-submodules --branch "${branch}" "$CLONE_URL" /workspace 2>&1) || {
  SANITIZED_OUTPUT=$(echo "$CLONE_OUTPUT" | sed -E 's/(x-access-token:|ghs_|ghp_|github_pat_)[^ @]*/***REDACTED***/g')
  echo "$SANITIZED_OUTPUT"
  if echo "$CLONE_OUTPUT" | grep -q "terminal prompts disabled\\|could not read Username\\|Authentication failed\\|403"; then
    echo ""
    echo "========================================="
    echo "ERROR: GitHub authentication failed."
    echo "Your GitHub account is not connected or does not have access to this repository."
    echo "Please connect your GitHub account in User Settings > GitHub."
    echo "========================================="
  fi
  exit 1
}
echo "$CLONE_OUTPUT" | sed -E 's/(x-access-token:|ghs_|ghp_|github_pat_)[^ @]*/***REDACTED***/g'

echo "=== Repository cloned successfully ==="
echo "Checked out commit: $(git -C /workspace rev-parse HEAD 2>/dev/null || echo unknown)"
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
      };

    const initContainers: k8s.V1Container[] = [sourceInit];

    // Env keys flow into Dockerfile directives and unquoted shell positions
    // below; a key containing a newline or shell metachar would inject
    // arbitrary instructions. Reject early — projects.service already
    // validates on write, this is defense-in-depth at the build boundary.
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of Object.keys(envVars)) {
      if (!ENV_KEY_RE.test(key)) {
        throw new BadRequestException(`Invalid environment variable key: ${key}`);
      }
    }

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

DOCKERFILE_PATH="${dockerfilePath}"
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

      // A railpack.json in the repo outranks env overrides, so the build
      // settings are re-emitted as the config file to keep the UI authoritative.
      // JSON.stringify never emits a raw newline, so the quoted heredoc below
      // cannot be broken out of by a command containing quotes or $.
      const overrideConfig = railpackConfigOverride(envVars);
      const configOverrideJson = overrideConfig ? JSON.stringify(overrideConfig) : '';
      const configFileArg = overrideConfig ? ` --config-file ${ORCHARD_RAILPACK_CONFIG}` : '';
      const configOverrideBlock = overrideConfig ? `
echo "=== Applying Orchard build settings over the repository config ==="
cat > /tmp/orchard-override.json <<'ORCHARD_RAILPACK_OVERRIDE'
${configOverrideJson}
ORCHARD_RAILPACK_OVERRIDE
if [ -f railpack.json ] && command -v jq >/dev/null 2>&1; then
  jq -s '.[0] * .[1]' railpack.json /tmp/orchard-override.json > ${ORCHARD_RAILPACK_CONFIG}
elif [ -f railpack.json ]; then
  echo "WARNING: jq unavailable; the build settings you set take precedence and railpack.json is ignored"
  cp /tmp/orchard-override.json ${ORCHARD_RAILPACK_CONFIG}
else
  cp /tmp/orchard-override.json ${ORCHARD_RAILPACK_CONFIG}
fi
` : '';

      initContainers.push({
        name: 'railpack-prepare',
        image: this.railpackMiseImage,
        command: ['/bin/sh', '-c'],
        args: [
          `set -ex
echo "=== Installing curl ==="
if command -v curl >/dev/null 2>&1${configOverrideJson ? ' && command -v jq >/dev/null 2>&1' : ''}; then
  echo "curl already installed, skipping"
elif command -v apt-get >/dev/null 2>&1; then
  # Tolerate non-fatal apt cleanup errors (e.g. I/O error closing
  # /var/lib/apt/extended_states) — verify curl exists after install.
  apt-get update || true
  apt-get install -y curl ${configOverrideJson ? 'jq' : ''} || true
  command -v curl >/dev/null 2>&1 || { echo "curl install failed"; exit 1; }
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl ${configOverrideJson ? 'jq' : ''}
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ${configOverrideJson ? 'jq' : ''}
fi

echo "=== Installing Railpack ${this.railpackVersion} ==="
case "$(uname -m)" in
  x86_64) RAILPACK_TARGET=x86_64-unknown-linux-musl ;;
  aarch64|arm64) RAILPACK_TARGET=arm64-unknown-linux-musl ;;
  *) echo "unsupported architecture: $(uname -m)"; exit 1 ;;
esac
RAILPACK_ASSET=railpack-${this.railpackVersion}-$RAILPACK_TARGET.tar.gz
RAILPACK_RELEASE=https://github.com/railwayapp/railpack/releases/download/${this.railpackVersion}
RAILPACK_TMP=$(mktemp -d)
cd "$RAILPACK_TMP"
curl -fsSL --retry 3 --retry-all-errors -O "$RAILPACK_RELEASE/$RAILPACK_ASSET"
curl -fsSL --retry 3 --retry-all-errors -O "$RAILPACK_RELEASE/checksums.txt"
grep " $RAILPACK_ASSET$" checksums.txt | sha256sum -c -
tar xzf "$RAILPACK_ASSET" railpack
install -m 0755 railpack /usr/local/bin/railpack
cd /
rm -rf "$RAILPACK_TMP"
export PATH="$PATH:/usr/local/bin"
railpack --version

echo "=== Selecting build directory ==="
# Two monorepo shapes need opposite treatment:
#   * A plain repo with frontend/ and backend/ — point Railpack straight at the
#     subdirectory; it supports that natively via its app source dir.
#   * A pnpm/npm/yarn workspace — the lockfile and shared packages live at the
#     root, so building inside the subdirectory would fail to install. Stay at
#     the root; the build/start commands are already scoped to the package and
#     the output directory is already repo-relative.
ORCHARD_ROOT_DIR=${JSON.stringify(rootDirectory ?? '')}
ORCHARD_BUILD_DIR=/workspace
if [ -n "$ORCHARD_ROOT_DIR" ]; then
  if [ -f /workspace/pnpm-workspace.yaml ] || grep -q '"workspaces"' /workspace/package.json 2>/dev/null; then
    echo "workspace detected: building from the repo root, scoped to $ORCHARD_ROOT_DIR"
  elif [ -d "/workspace/$ORCHARD_ROOT_DIR" ]; then
    ORCHARD_BUILD_DIR="/workspace/$ORCHARD_ROOT_DIR"
    echo "building from $ORCHARD_BUILD_DIR"
  else
    echo "root directory '$ORCHARD_ROOT_DIR' not found in the repository"; exit 1
  fi
fi
# The BuildKit container reads this back: its working directory has to match
# the one the plan was generated for, and it is fixed in the pod spec before
# any of the above is known.
echo "$ORCHARD_BUILD_DIR" > /workspace/.orchard-build-dir

cd "$ORCHARD_BUILD_DIR"
${configOverrideBlock}
echo "=== Running Railpack prepare ==="
railpack prepare . --plan-out railpack-plan.json --info-out railpack-info.json ${envArgs}${configFileArg}

echo "=== Railpack prepare completed ==="
echo "Generated files:"
ls -la railpack-plan.json railpack-info.json 2>/dev/null || echo "Warning: Some files may not have been generated"

# Show build info for logging
if [ -f railpack-info.json ]; then
  echo "=== Build Info ==="
  cat railpack-info.json
  # Single-line copy behind a sentinel so the server can reconcile what
  # Railpack actually detected against what the create form guessed. The
  # pretty-printed dump above is for humans reading the build log.
  # Container runtimes split log lines past ~16KB; if this info ever grows
  # beyond that the parser simply finds no detection, which costs a label
  # and never the build.
  echo "${RAILPACK_INFO_MARKER}$(tr -d '\\n' < railpack-info.json)"
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

    // Persistent daemon mode: get/create a warm BuildKit daemon and build
    // a lightweight client container that connects to it via gRPC. The
    // daemon keeps its layer cache warm between builds (like Depot).
    let daemonIp: string | null = null;
    if (persistentBuildCache && !buildWithDepot && this.buildKitPool) {
      try {
        const daemon = await this.buildKitPool.getOrCreateDaemon(cacheTenantKey || imageName);
        daemonIp = daemon.podIp;
        await this.appendLog(deploymentId, `Using persistent BuildKit daemon at ${daemon.podName}`);
      } catch (err) {
        console.warn(`[ImageBuilder] Failed to get daemon, falling back to daemonless:`, err.message);
        await this.appendLog(deploymentId, `Persistent daemon unavailable, using standard builder`, 'WARNING');
      }
    }

    // Build the BuildKit container spec.
    // Two modes:
    //   1. Daemon mode (daemonIp set): lightweight client runs `buildctl
    //      --addr tcp://<daemon>:1234 build ...`. Not privileged, no
    //      buildkitd flags, no cache volumes (daemon has those).
    //   2. Daemonless mode (default): runs `buildctl-daemonless.sh` which
    //      starts+stops its own buildkitd. Privileged, needs config/state.
    //
    // sidecarPushEnabled changes credential handling in both modes:
    //   - no docker-config mount — the build cannot exfiltrate push creds.
    //   - mount `output` emptyDir at /output for the OCI tarball.
    const buildkitContainer: k8s.V1Container | null = buildWithDepot ? null : (() => {
      if (daemonIp) {
        // --- Daemon client mode ---
        // buildctl sends the local context directory to the remote daemon
        // over gRPC, so the client needs /workspace but NOT privilege.
        const shellQuote = (arg: string) =>
          /^[A-Za-z0-9_\-./:=@,+%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
        const clientCmd = `buildctl --addr tcp://${daemonIp}:1234 ${buildctlArgs.map(shellQuote).join(' ')}${
          injectGitSha ? ImageBuilderService.GIT_SHA_BUILDCTL_OPT : ''
        }`;
        const clientScript =
          (injectGitSha ? ImageBuilderService.GIT_SHA_PREAMBLE : '') +
          // Same directory handoff as the daemonless path: buildctl streams the
          // local context from the client's cwd, so it must match the directory
          // railpack-prepare generated the plan for.
          ImageBuilderService.BUILD_DIR_PREAMBLE +
          this.generateRetryScript(clientCmd);

        return {
          name: 'buildkit',
          image: this.buildkitImage,
          // Not privileged — just a gRPC client. The daemon pod has registry
          // creds and pushes directly, so the client doesn't need docker-config.
          command: ['/bin/sh', '-c'],
          args: [clientScript],
          workingDir: '/workspace',
          env: [
            ...Object.entries(envVars).map(([key, value]) => ({
              name: key,
              value,
            })),
          ],
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
          ],
          resources: {
            requests: { cpu: '200m', memory: '512Mi' },
            limits: { cpu: '2', memory: '4Gi' },
          },
        } as k8s.V1Container;
      }

      // --- Daemonless mode (original) ---
      const scriptArgs = this.sidecarPushEnabled
        ? buildctlArgs.filter((arg, idx, arr) => {
            if (arg === '--export-cache') return false;
            if (idx > 0 && arr[idx - 1] === '--export-cache') return false;
            return true;
          })
        : buildctlArgs;
      return {
        name: 'buildkit',
        image: this.buildkitImage,
        securityContext: { privileged: true },
        command: ['/bin/sh', '-c'],
        args: [this.generateBuildScriptWithCacheFallback(scriptArgs, injectGitSha)],
        workingDir: '/workspace',
        env: [
          ...(this.sidecarPushEnabled
            ? []
            : [{ name: 'DOCKER_CONFIG', value: '/root/.docker' }]),
          { name: 'BUILDKITD_FLAGS', value: `--config /etc/buildkit/buildkitd.toml${this.workspaceTmpfs || this.scratchBlock ? ' --root /buildkit-state' : ''}` },
          ...(this.s3CacheEnabled && !this.localCacheEnabled ? [
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
          ...Object.entries(envVars).map(([key, value]) => ({
            name: key,
            value,
          })),
        ],
        volumeMounts: [
          { name: 'workspace', mountPath: '/workspace' },
          ...(this.sidecarPushEnabled ? [] : [{
            name: 'docker-config',
            mountPath: '/root/.docker',
            readOnly: true,
          }]),
          { name: 'buildkit-config', mountPath: '/etc/buildkit', readOnly: true },
          ...(this.sidecarPushEnabled ? [{
            name: 'output',
            mountPath: '/output',
          }] : []),
          ...(this.workspaceTmpfs && !this.scratchBlock ? [{
            name: 'buildkit-state',
            mountPath: '/buildkit-state',
          }] : []),
          ...(this.localCacheEnabled ? [{
            name: 'buildkit-cache',
            mountPath: this.localCachePath,
            subPath: cacheSubPath,
          }] : []),
        ],
        ...(this.scratchBlock ? {
          volumeDevices: [{ name: 'buildkit-state', devicePath: ImageBuilderService.SCRATCH_DEVICE }],
        } : {}),
        resources: {
          requests: { cpu: '500m', memory: '2Gi' },
          limits: { cpu: '4', memory: process.env.BUILDER_MEMORY_LIMIT || '32Gi' },
        },
      } as k8s.V1Container;
    })();

    // Pusher container — only used when sidecarPushEnabled. Polls for a
    // done-marker written by BuildKit, then `skopeo copy`s the OCI
    // tarball to Harbor.
    //
    // Why run BuildKit + pusher as PARALLEL main containers (not init→main):
    //   Under runtimeClassName=kata, transitioning from the last init
    //   container to the first main container triggers a 429 from the
    //   kata-shim's task-create RPC — the kata-agent inside the VM
    //   doesn't accept new tasks during sandbox-state-transition. Running
    //   both as `containers:` avoids that transition entirely; both tasks
    //   start once at pod startup, share /output via emptyDir, and
    //   coordinate via a filesystem marker.
    //
    // Threat model still holds: BuildKit and pusher have separate mount
    // namespaces inside the Kata VM, so a malicious Dockerfile RUN in
    // BuildKit cannot read the pusher container's
    // /root/.docker/config.json.
    // No pusher in daemon mode — the daemon pushes directly (it has creds).
    const pusherContainer: k8s.V1Container | null = (buildkitContainer && this.sidecarPushEnabled && !daemonIp) ? {
      name: 'pusher',
      image: this.pusherImage,
      command: ['/bin/sh', '-c'],
      args: [
        `set -e
echo "[pusher] waiting for build to finish..."
TIMEOUT=1700
ELAPSED=0
while [ ! -f /output/.done ] && [ ! -f /output/.failed ]; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "[pusher] timed out waiting for build to produce a marker"
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done
if [ -f /output/.failed ]; then
  echo "[pusher] build wrote .failed marker — not pushing"
  exit 1
fi
echo "[pusher] build done, pushing..."
exec skopeo copy --authfile /root/.docker/config.json --dest-tls-verify=false oci-archive:/output/image.tar 'docker://${fullImageName.replace(/'/g, `'\\''`)}'`,
      ],
      volumeMounts: [
        { name: 'output', mountPath: '/output' },
        { name: 'docker-config', mountPath: '/root/.docker', readOnly: true },
      ],
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      },
    } : null;

    // Final container layout:
    //   - Depot: depot container as main, no buildkit/pusher.
    //   - sidecarPush off (default): buildkit as main, classic behaviour.
    //   - sidecarPush on: both run as main in parallel. BuildKit wraps
    //     its build script to write /output/.done or /output/.failed on
    //     exit so the pusher knows when to act.
    let containers: k8s.V1Container[];
    if (buildWithDepot) {
      containers = [this.createDepotContainer({ dockerfilePath, fullImageName, target, buildFromRoot, buildType, envVars })];
    } else if (this.sidecarPushEnabled && pusherContainer && buildkitContainer) {
      const innerScript = (buildkitContainer.args && buildkitContainer.args[0]) || '';

      const shellQuote2 = (arg: string) =>
        /^[A-Za-z0-9_\-./:=@,+%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
      const cacheExportArgs = buildctlArgs.map(a =>
        a.includes('dest=/output/image.tar')
          ? a.replace('dest=/output/image.tar', 'dest=/tmp/cache-export.tar')
          : a,
      ).map(shellQuote2).join(' ');
      const hasCacheExport = buildctlArgs.some(a => a === '--export-cache');

      buildkitContainer.args = [
        `mkdir -p /output
${this.scratchMountPreamble}
# Start buildkitd ourselves and replace buildctl-daemonless.sh with a
# passthrough so the inner build script (with all its retry logic) reuses
# our daemon instead of spawning its own.
printf '#!/bin/sh\\nexec buildctl "$@"\\n' > /usr/bin/buildctl-daemonless.sh

buildkitd $BUILDKITD_FLAGS &
DAEMON_PID=$!
for i in $(seq 1 100); do
  buildctl debug workers >/dev/null 2>&1 && break
  sleep 0.1
done

( ${innerScript} ); rc=$?

if [ "$rc" -eq 0 ]; then
  touch /output/.done
${hasCacheExport ? `  echo "=== Exporting build cache ==="
  buildctl ${cacheExportArgs} >/dev/null 2>&1 || echo "=== Cache export failed (non-critical) ==="
  rm -f /tmp/cache-export.tar` : ''}
else
  touch /output/.failed
fi

kill $DAEMON_PID 2>/dev/null
wait $DAEMON_PID 2>/dev/null || true
exit $rc`,
      ];
      containers = [buildkitContainer, pusherContainer];
    } else {
      containers = [buildkitContainer!];
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
          'orchard.my/deployment-id': deploymentId || 'unknown',
          'orchard.my/image-name': truncateK8sName(
            imageName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, ''),
            63,
          ),
          'orchard.my/build-type': buildType,
        },
        annotations: {
          'orchard.my/repo-url': repoUrl,
          'orchard.my/branch': branch,
          'orchard.my/full-image': fullImageName,
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
              'orchard.my/deployment-id': deploymentId || 'unknown',
            },
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: 'image-builder',
            // The build pod has no business talking to the kube-apiserver.
            // The image-builder SA's Role grants pods/secrets read in this
            // namespace; without this line the SA token is auto-mounted at
            // /var/run/secrets/kubernetes.io/serviceaccount/ inside BuildKit
            // and a Dockerfile that reaches BuildKit's container fs (via
            // any future BuildKit parser bug or `--mount` edge case) could
            // exfil the Harbor push creds via the apiserver.
            automountServiceAccountToken: false,
            // Builder pod runtime: Kata (lightweight VM) when configured.
            // Empty/undefined ⇒ default containerd handler (runc) — matches
            // legacy behaviour on first upgrade.
            // Daemon-client mode doesn't need Kata — it's just a gRPC client,
            // the daemon pod itself runs with the runtime class.
            ...(!daemonIp && this.builderRuntimeClass ? { runtimeClassName: this.builderRuntimeClass } : {}),
            ...(this.dedicatedNodeEnabled ? {
              nodeSelector: { 'orchard-builder': 'true' },
              tolerations: [{
                key: 'orchard-builder',
                operator: 'Exists',
                effect: 'NoSchedule',
              }],
            } : {}),
            initContainers,
            containers,
            volumes: [
              {
                name: 'workspace',
                emptyDir: this.workspaceTmpfs ? { medium: 'Memory' } : {},
              },
              {
                name: 'docker-config',
                secret: {
                  secretName: this.registrySecretName,
                  items: [
                    {
                      key: '.dockerconfigjson',
                      path: 'config.json',
                    },
                  ],
                },
              },
              // Daemon-client mode doesn't need buildkit-config, buildkit-state,
              // or buildkit-cache — the daemon pod has its own.
              ...(!daemonIp ? [{
                name: 'buildkit-config',
                configMap: {
                  name: 'buildkit-config',
                },
              }] : []),
              ...(this.sidecarPushEnabled ? [{
                name: 'output',
                emptyDir: this.workspaceTmpfs ? { medium: 'Memory' } : {},
              }] : []),
              ...(!daemonIp && (this.workspaceTmpfs || this.scratchBlock) ? [{
                name: 'buildkit-state',
                ...(this.scratchBlock
                  ? {
                      ephemeral: {
                        volumeClaimTemplate: {
                          spec: {
                            accessModes: ['ReadWriteOnce'],
                            storageClassName: this.scratchStorageClass,
                            volumeMode: 'Block',
                            resources: { requests: { storage: this.scratchSize } },
                          },
                        },
                      },
                    }
                  : { emptyDir: { medium: 'Memory' } }),
              }] : []),
              ...(!daemonIp && this.localCacheEnabled ? [{
                name: 'buildkit-cache',
                ...(this.localCachePvc && !options.disableSharedCache
                  ? { persistentVolumeClaim: { claimName: this.localCachePvc } }
                  : { emptyDir: {} }),
              }] : []),
            ],
          },
        },
      },
    };

    let cacheBackend = 'none';
    if (this.localCacheEnabled) cacheBackend = 'local';
    else if (this.s3CacheEnabled) cacheBackend = 's3';

    console.log(`[ImageBuilder] Creating job ${jobName} in namespace ${this.builderNamespace}`, {
      imageName: fullImageName,
      repoUrl: this.sanitizeLogMessage(repoUrl),
      branch,
      dockerfilePath,
      buildType,
      initContainerCount: initContainers.length,
      hasCacheEnabled: this.localCacheEnabled || this.s3CacheEnabled,
      cacheBackend,
      envVarsCount: Object.keys(envVars).length,
    });

    try {
      const jobCreationResult = await batchApi.createNamespacedJob(this.builderNamespace, job);
      console.log(`[ImageBuilder] Job ${jobName} created successfully. UID: ${jobCreationResult.body.metadata?.uid}`);

      if (deploymentId) {
        const now = Date.now();
        const logLine = `[${now}] [INFO] Build job ${jobName} created successfully\n`;
        await this.prisma.$executeRaw`
          UPDATE "deployments"
          SET "build_logs" = COALESCE("build_logs", '') || ${logLine},
              "build_step_timestamps" = jsonb_set(
                jsonb_set(
                  COALESCE("build_step_timestamps", '{}'::jsonb),
                  '{__jobName}',
                  ${JSON.stringify(jobName)}::jsonb
                ),
                '{__image}',
                ${JSON.stringify(`${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`)}::jsonb
              ),
              "updated_at" = NOW()
          WHERE "id" = ${deploymentId}::uuid
        `;
        this.emitBuildChanged(deploymentId).catch(() => {});
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
    skipCache?: boolean;
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
    if (!('BUILDKIT_DOCKERFILE_CHECK' in envVars)) {
      args.push('--opt', 'build-arg:BUILDKIT_DOCKERFILE_CHECK=skip=SecretsUsedInArgOrEnv');
    }

    // Add cache arguments (namespaced per image to prevent cross-deployment contamination)
    // Skip when using persistent daemon — its content store IS the cache.
    // Strip the tag from the cache key — tags change per build (timestamp), so
    // including them means every build writes to a unique cache path and never
    // gets a hit. Also strip the registry/project prefix since it's constant.
    if (!options.skipCache) {
      const cacheImageKey = fullImageName.replace(/:[^/]*$/, '').replace(/^[^/]*\/[^/]*\//, '');
      const cacheArgs = this.buildCacheArgs(cacheImageKey);
      for (const cacheArg of cacheArgs) {
        args.push(cacheArg);
      }
    }

    // Output mode:
    //   - Persistent daemon: always push directly — the daemon has registry
    //     creds and sidecar push doesn't work across pods.
    //   - sidecarPushEnabled: write OCI tarball to /output for the pusher
    //     sidecar container.
    //   - Default: push directly from BuildKit.
    if (this.sidecarPushEnabled && !options.skipCache) {
      args.push('--output', `type=oci,"name=${fullImageName}",dest=/output/image.tar`);
    } else {
      args.push('--output', `type=image,"name=${fullImageName}",push=true`);
    }

    return args;
  }

  private generateBuildctlArgsForRailpack(options: {
    fullImageName: string;
    envVars: Record<string, string>;
    secretsHash: string;
    cacheKey?: string;
    skipCache?: boolean;
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
      '--opt', `source=${this.railpackFrontendImage}`,
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

    // Skip cache when using persistent daemon — its content store IS the cache.
    if (!options.skipCache) {
      const cacheImageKey = fullImageName.replace(/:[^/]*$/, '').replace(/^[^/]*\/[^/]*\//, '');
      const cacheArgs = this.buildCacheArgs(cacheImageKey);
      for (const cacheArg of cacheArgs) {
        args.push(cacheArg);
      }
    }

    if (this.sidecarPushEnabled && !options.skipCache) {
      args.push('--output', `type=oci,"name=${fullImageName}",dest=/output/image.tar`);
    } else {
      args.push('--output', `type=image,"name=${fullImageName}",push=true`);
    }

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
    skipCache?: boolean;
  }): string[] {
    const { buildType, fullImageName, envVars, secretsHash, cacheKey, skipCache, ...dockerfileOptions } = options;

    if (buildType === 'railpack') {
      return this.generateBuildctlArgsForRailpack({
        fullImageName,
        envVars,
        secretsHash: secretsHash || '',
        cacheKey,
        skipCache,
      });
    }

    return this.generateBuildctlArgsForDockerfile({
      ...dockerfileOptions,
      fullImageName,
      envVars,
      skipCache,
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

  /**
   * Emit per-phase spans (clone / image build / registry push) for a finished
   * build job, using the exact container timestamps Kubernetes reports:
   * git-clone init container, buildkit main container, pusher sidecar.
   * Best-effort — failures here never affect the build result.
   */
  private async emitBuildPhaseSpans(jobName: string, deploymentId?: string): Promise<void> {
    try {
      this.ensureKubeConfig();
      const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
      const pods = await coreApi.listNamespacedPod(
        this.builderNamespace,
        undefined, undefined, undefined, undefined,
        `job-name=${jobName}`,
      );
      const pod = pods.body.items[0];
      if (!pod) return;

      const tags = { 'build.job_name': jobName, 'build.deployment_id': deploymentId };
      const windowOf = (s?: k8s.V1ContainerStatus) => {
        const t = s?.state?.terminated;
        if (!t?.startedAt || !t?.finishedAt) return null;
        return { start: new Date(t.startedAt).getTime(), end: new Date(t.finishedAt).getTime() };
      };

      const clone = windowOf(pod.status?.initContainerStatuses?.find((c) => c.name === 'git-clone'));
      if (clone) recordPhaseSpan('build.clone', clone.start, clone.end, tags);

      const image = windowOf(pod.status?.containerStatuses?.find((c) => c.name === 'buildkit'));
      if (image) recordPhaseSpan('build.image', image.start, image.end, tags);

      // The pusher sidecar starts with the pod and idles until buildkit hands
      // it the image, so clamp its window to begin where the build ended —
      // otherwise "push" would include the whole build as wait time.
      const push = windowOf(pod.status?.containerStatuses?.find((c) => c.name === 'pusher'));
      if (push) {
        const start = image ? Math.max(push.start, image.end) : push.start;
        recordPhaseSpan('build.push', start, push.end, tags);
      }
    } catch (error) {
      console.warn(`[ImageBuilder] Failed to emit build phase spans for ${jobName}:`, (error as Error).message);
    }
  }

  /**
   * Record what Railpack actually detected, so the UI can show the real answer
   * instead of the create-form's guess. Best effort: a build that succeeded
   * must never fail because we could not store a label.
   */
  private async persistRailpackDetection(
    deploymentId: string | undefined,
    infoLog: string,
  ): Promise<void> {
    if (!deploymentId) return;

    const detection = parseRailpackInfo(infoLog);
    if (!detection) return;

    try {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { detectedConfig: detection as unknown as object },
      });
    } catch (error) {
      console.warn(`[ImageBuilder] Could not persist Railpack detection for ${deploymentId}:`, error.message);
    }
  }

  /**
   * Pull the marker line the railpack-prepare init container echoed.
   *
   * The normal log path only reads the buildkit container — init container
   * logs are a failure-path fallback — so this is a targeted read. It runs at
   * most once per job (the status poll is on a timer) and only after the
   * container has terminated, since the marker is the last thing it prints.
   */
  private async readRailpackInfoLog(
    coreApi: k8s.CoreV1Api,
    podName: string | undefined,
    jobName: string,
    initContainerStatuses: k8s.V1ContainerStatus[] | undefined,
  ): Promise<string | undefined> {
    if (!podName || this.railpackInfoFetched.has(jobName)) return undefined;

    const prepare = initContainerStatuses?.find((ics) => ics.name === 'railpack-prepare');
    if (!prepare?.state?.terminated) return undefined;

    this.railpackInfoFetched.add(jobName);

    try {
      const res = await coreApi.readNamespacedPodLog(
        podName,
        this.builderNamespace,
        'railpack-prepare',
        undefined, undefined, undefined, undefined, undefined, undefined,
        // The marker is the final line; a small tail keeps this cheap even
        // though railpack's own output can be long.
        50,
      );
      return typeof res.body === 'string' ? res.body : undefined;
    } catch (error) {
      console.warn(`[ImageBuilder] Could not read railpack-prepare logs for ${podName}:`, error.message);
      return undefined;
    }
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
      let pusherLogs = '';
      let railpackInfoLog: string | undefined;

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

          railpackInfoLog = await this.readRailpackInfoLog(
            coreApi,
            podName,
            jobName,
            initContainerStatuses,
          );

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

              const hasPusherContainer = containerStatuses?.some((cs) => cs.name === 'pusher');
              if (hasPusherContainer && status !== 'pending') {
                try {
                  const pusherLog = await coreApi.readNamespacedPodLog(
                    podName,
                    this.builderNamespace,
                    'pusher',
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    5000
                  );
                  if (pusherLog.body && pusherLog.body.trim().length > 0) {
                    pusherLogs = pusherLog.body;
                  }
                } catch (pusherLogError) {
                  console.warn(`[ImageBuilder] Could not fetch pusher logs for pod ${podName}:`, pusherLogError.message);
                }
              }
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

      const imageRef = jobSpec.metadata?.annotations?.['orchard.my/full-image']
        ?? jobSpec.metadata?.annotations?.['orchard.dev/full-image'];

      return {
        jobName,
        status,
        logs,
        pusherLogs,
        imageRef,
        railpackInfoLog,
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

  async waitForBuildJob(jobName: string, deploymentId?: string, timeoutMs = 1800000): Promise<BuildJobStatus> {
    const startTime = Date.now();
    const pollInterval = 3000;
    let lastLoggedStatus = '';
    let pollCount = 0;

    console.log(`[ImageBuilder] Starting to wait for build job ${jobName} (timeout: ${timeoutMs / 1000}s, deploymentId: ${deploymentId})`);
    await this.seedLogOffsets(jobName, deploymentId);
    await this.appendLog(deploymentId, `Waiting for build job ${jobName} to complete...`);

    // Scheduling wait: job submitted → pod actually running. Finishes on the
    // first non-pending status observed (5s poll granularity).
    const scheduleSpan = startPhaseSpan('build.schedule', {
      'build.job_name': jobName,
      'build.deployment_id': deploymentId,
    });

    while (Date.now() - startTime < timeoutMs) {
      pollCount++;
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      
      try {
        const status = await this.getBuildJobStatus(jobName);

        if (status.railpackInfoLog) {
          await this.persistRailpackDetection(deploymentId, status.railpackInfoLog);
        }

        if (status.status !== 'pending' && status.status !== 'unknown') {
          scheduleSpan.finish({ 'build.schedule_outcome': status.status });
        }

        if (status.status !== lastLoggedStatus) {
          console.log(`[ImageBuilder] Job ${jobName} status changed: ${lastLoggedStatus} -> ${status.status} (poll #${pollCount}, elapsed: ${elapsedSeconds}s)`);
          lastLoggedStatus = status.status;
        }

        if (status.status === 'succeeded') {
          console.log(`[ImageBuilder] Build job ${jobName} completed successfully after ${elapsedSeconds}s`);
          await this.streamBuildkitOutput(deploymentId, jobName, status.logs);
          await this.streamPusherOutput(deploymentId, jobName, status.pusherLogs);
          this.appendLog(deploymentId, `Build job ${jobName} completed successfully`).catch(() => {});
          this.clearBuildkitOffset(jobName);
          this.emitBuildPhaseSpans(jobName, deploymentId).catch(() => {});
          return status;
        }

        if (status.status === 'failed') {
          const errorMsg = status.logs || 'Unknown error - no logs available';
          console.error(`[ImageBuilder] Build job ${jobName} failed after ${elapsedSeconds}s. Error: ${errorMsg.substring(0, 500)}`);
          await this.streamBuildkitOutput(deploymentId, jobName, status.logs);
          await this.streamPusherOutput(deploymentId, jobName, status.pusherLogs);
          await this.appendLog(deploymentId, `Build job ${jobName} failed`, 'ERROR');

          if (!status.logs && !status.pusherLogs) {
            await this.appendLog(deploymentId, 'No build logs available - this may indicate a pod scheduling or initialization failure', 'ERROR');
          }

          this.clearBuildkitOffset(jobName);
          this.buildkitPushDetected.delete(jobName);
          this.buildkitBuildingDetected.delete(jobName);
          await this.emitBuildPhaseSpans(jobName, deploymentId);

          const summary = this.summarizeBuildFailure(status.logs, status.pusherLogs);
          throw new BadRequestException(
            summary
              ? `Build failed: ${summary}`
              : 'Build failed: No logs available. This typically indicates a pod scheduling failure, image pull error, or init container failure. Check Kubernetes pod events for more details.',
          );
        }

        if (status.status === 'running') {
          await this.streamBuildkitOutput(deploymentId, jobName, status.logs);
          if (this.buildkitPushDetected.has(jobName)) {
            await this.streamPusherOutput(deploymentId, jobName, status.pusherLogs);
          }
        } else if (deploymentId) {
          this.prisma.$executeRaw`
            UPDATE "deployments" SET "updated_at" = NOW() WHERE "id" = ${deploymentId}::uuid
          `.catch(() => {});
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

      await new Promise(resolve => { setTimeout(resolve, pollInterval); });
    }

    const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
    console.error(`[ImageBuilder] Build job ${jobName} timed out after ${finalElapsed}s (${pollCount} polls)`);
    await this.appendLog(deploymentId, `Build job ${jobName} timed out after ${finalElapsed}s`, 'ERROR');
    
    try {
      const finalStatus = await this.getBuildJobStatus(jobName);
      await this.streamBuildkitOutput(deploymentId, jobName, finalStatus.logs);
      await this.streamPusherOutput(deploymentId, jobName, finalStatus.pusherLogs);
      await this.appendLog(deploymentId, `Final status: ${finalStatus.status}`, 'ERROR');
    } catch (finalCheckError) {
      console.error(`[ImageBuilder] Could not fetch final status:`, finalCheckError.message);
    }

    this.clearBuildkitOffset(jobName);
    this.buildkitPushDetected.delete(jobName);
    this.buildkitBuildingDetected.delete(jobName);
    scheduleSpan.finish({ 'build.schedule_outcome': 'timeout' });
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
      const labelSelector = `orchard.my/deployment-id=${deploymentId}`;
      console.log(`[ImageBuilder] Looking for build jobs with label selector: ${labelSelector}`);

      const [current, legacy] = await Promise.all([
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          labelSelector
        ),
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `orchard.dev/deployment-id=${deploymentId}`
        ),
      ]);
      const jobNames = new Set<string>();
      const jobs = {
        body: {
          items: [...current.body.items, ...legacy.body.items].filter((j) => {
            const n = j.metadata?.name;
            if (!n || jobNames.has(n)) return false;
            jobNames.add(n);
            return true;
          }),
        },
      };

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
      if (deploymentId) {
        const now = Date.now();
        const logLine = `[${now}] [INFO] Starting BuildKit build for ${this.sanitizeLogMessage(repoUrl)}@${branch} (type: ${buildType})\n`;
        await this.prisma.$executeRaw`
          UPDATE "deployments"
          SET "build_step" = 'cloning',
              "build_logs" = COALESCE("build_logs", '') || ${logLine},
              "build_step_timestamps" = jsonb_set(
                COALESCE("build_step_timestamps", '{}'::jsonb),
                '{cloning}',
                ${now}::text::jsonb
              ),
              "updated_at" = NOW()
          WHERE "id" = ${deploymentId}::uuid
        `;
        this.emitBuildChanged(deploymentId).catch(() => {});
      }

      const jobName = await this.createBuildJob(options);
      console.log(`[ImageBuilder] Created build job: ${jobName}`);

      await this.waitForBuildJob(jobName, deploymentId);

      if (deploymentId && !this.buildkitPushDetected.has(jobName)) {
        this.prisma.$executeRaw`
          UPDATE "deployments"
          SET "build_step" = 'pushing',
              "build_step_timestamps" = jsonb_set(
                COALESCE("build_step_timestamps", '{}'::jsonb),
                '{pushing}',
                ${Date.now()}::text::jsonb
              )
          WHERE "id" = ${deploymentId}::uuid
        `.catch(() => {});
        this.emitBuildChanged(deploymentId).catch(() => {});
      }
      this.buildkitPushDetected.delete(jobName);
      this.buildkitBuildingDetected.delete(jobName);

      const fullImagePath = `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`;

      console.log(`[ImageBuilder] Build completed successfully: ${fullImagePath}`);
      const imageRef = fullImagePath.split('/').slice(-1)[0] || fullImagePath;
      this.appendLog(deploymentId, `Build and push completed successfully.`).catch(() => {});
      this.appendLog(deploymentId, `Image: ${imageRef}`).catch(() => {});
      this.deleteBuildJob(jobName).catch(err => console.error('[ImageBuilder] Failed to delete build job:', err));

      return fullImagePath;
    } catch (error) {
      if (!options.disableSharedCache && this.localCacheEnabled && this.localCachePvc) {
        let logTail = '';
        if (deploymentId) {
          const dep = await this.prisma.deployment
            .findUnique({ where: { id: deploymentId }, select: { buildLogs: true } })
            .catch(() => null);
          logTail = (dep?.buildLogs ?? '').slice(-20000);
        }
        if (/no space left on device|ENOSPC/i.test(`${error?.message ?? ''}\n${logTail}`)) {
          console.warn(`[ImageBuilder] Cache-full failure for ${imageName}:${tag}, retrying without shared cache`);
          await this.appendLog(
            deploymentId,
            'Shared build cache ran out of space. Retrying the build without it.',
          ).catch(() => {});
          return this.buildAndPush({ ...options, disableSharedCache: true });
        }
      }

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

  async findBuildJobsForDeployment(deploymentId: string): Promise<{ name: string; image: string | null; status: string }[] | null> {
    this.ensureKubeConfig();
    try {
      const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);
      const [current, legacy] = await Promise.all([
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined, undefined, undefined, undefined,
          `orchard.my/deployment-id=${deploymentId}`,
        ),
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined, undefined, undefined, undefined,
          `orchard.dev/deployment-id=${deploymentId}`,
        ),
      ]);
      const seen = new Set<string>();
      const items = [...current.body.items, ...legacy.body.items].filter((j) => {
        const n = j.metadata?.name;
        if (!n || seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      return items
        .sort((a, b) => {
          const ta = a.metadata?.creationTimestamp?.getTime() ?? 0;
          const tb = b.metadata?.creationTimestamp?.getTime() ?? 0;
          return tb - ta;
        })
        .map(j => {
          let status = 'pending';
          if (j.status?.succeeded) status = 'succeeded';
          else if (j.status?.failed) status = 'failed';
          else if (j.status?.active) status = 'running';
          return {
            name: j.metadata?.name || '',
            image: j.metadata?.annotations?.['orchard.my/full-image'] || j.metadata?.annotations?.['orchard.dev/full-image'] || null,
            status,
          };
        });
    } catch {
      return null;
    }
  }

  async imageExistsInRegistry(image: string): Promise<boolean | null> {
    try {
      const { repoName, tag } = this.parseImageRef(image);
      if (!tag) return null;
      const auth = this.getHarborAuth();
      if (!auth) return null;
      const url = `${auth.registryUrl}/api/v2.0/projects/${this.harborProject}/repositories/${encodeURIComponent(repoName)}/artifacts/${encodeURIComponent(tag)}`;
      const response = await fetch(url, { headers: { Authorization: auth.authHeader } });
      if (response.ok) return true;
      if (response.status === 404) return false;
      return null;
    } catch {
      return null;
    }
  }

  getImagePath(imageName: string, tag = 'latest'): string {
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
      if (repo.startsWith(`${prefix  }/`)) {
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
    const authHeader = `Basic ${  Buffer.from(`${harborUsername}:${harborPassword}`).toString('base64')}`;
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
