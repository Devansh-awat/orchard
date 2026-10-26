import { RegistryCredentialsService } from '../projects/registry-credentials.service';
import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import { parseRepoUrl, withCloneCredentials } from './repo-url';
import { decodeCloneCredential, redactUrlUserinfo } from '../git/clone-credential';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { resolveEnvVars } from '../env/env-resolver';
import {
  railpackOverrideEnv,
  parseRailpackInfo,
  normalizeRootDirectory,
  RAILPACK_INFO_MARKER
} from './build-config';
import { ImageBuilderService } from './image-builder.service';
import { BUILD_PLATFORM } from './build-platform';
import {
  hasRegistryAuths,
  isPullAuthEnvKey,
  PullAuthError,
  pullAuthsFromEnv,
  type RegistryAuths
} from './registry-pull-auth';

const execAsync = promisify(exec);

// Allow letters, digits, `_`, `.`, `/`, `-`. Reject leading `-` (git option
// smuggling), `..` segments (path traversal in refs), and any whitespace.
// This is intentionally narrower than git's full ref grammar — it's the
// shape of every realistic branch/tag name in practice.
function isSafeGitRef(ref: string): boolean {
  if (!ref || typeof ref !== 'string') return false;
  if (ref.length > 200) return false;
  if (ref.startsWith('-')) return false;
  if (ref.includes('..')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

type BuildType = 'dockerfile' | 'railpack';
type BuildMode = 'local' | 'kubernetes';

interface BuildOptions {
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  imageName: string;
  tag?: string;
  deploymentId?: string;
  accessToken?: string;
  target?: string;
  buildFromRoot?: boolean;
  buildType?: BuildType;
  buildMode?: BuildMode;
  buildWithDepot?: boolean;
  // Forwarded to ImageBuilderService as the per-tenant subPath on the
  // shared buildkit-cache PVC. Callers should set this to the project's
  // namespace.
  cacheTenantKey?: string;
  persistentBuildCache?: boolean;
  // Presigned GET URL for an uploaded build-context tarball ("orchard up").
  // Kubernetes build mode only; the local Docker fallback cannot use it.
  localContextUrl?: string;
  builder?: 'kubernetes' | 'depot' | 'firecracker';
}

@Injectable()
export class DockerService {
  private readonly harborRegistryPush = process.env.DOCKER_REGISTRY_PUSH || '178.156.144.127';

  private readonly harborRegistryPull = process.env.DOCKER_REGISTRY_PULL || 'harbor.1mp.dev';

  private readonly harborProject = process.env.REGISTRY_PROJECT || 'orchard';

  private readonly registryNoProxy = [
    this.harborRegistryPush,
    this.harborRegistryPull,
    ...(process.env.BUILD_NO_PROXY_EXTRA || '').split(',').filter(Boolean)
  ].join(',');

  private activeBuilds = 0;

  private buildsSincePrune = 0;

  private pendingPrune = false;

  private pruneLock: Promise<void> = Promise.resolve();

  // Default build mode - can be overridden per-build or via environment variable
  private readonly defaultBuildMode: BuildMode =
    (process.env.BUILD_MODE as BuildMode) || 'kubernetes';

  // Kept in lockstep with ImageBuilderService's pin — the local-docker fallback
  // must execute plans with the same frontend the Kubernetes path uses.
  private readonly railpackFrontendImage =
    process.env.RAILPACK_FRONTEND_IMAGE ||
    `ghcr.io/railwayapp/railpack-frontend:${process.env.RAILPACK_VERSION || 'v0.33.0'}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secretCrypto: SecretCryptoService,
    @Optional() private readonly imageBuilderService?: ImageBuilderService,
    @Optional() private readonly registryCredentials?: RegistryCredentialsService
  ) {}

  /**
   * The app's directory inside the repo, re-validated on the way out. Stored
   * values were normalized when they were saved, but this string is
   * interpolated into the build pod's shell script, so it is checked again
   * rather than trusted.
   */
  private async loadRootDirectory(deploymentId: string | undefined): Promise<string | null> {
    if (!deploymentId) return null;
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { rootDirectory: true }
      });
      return normalizeRootDirectory(deployment?.rootDirectory);
    } catch {
      return null;
    }
  }

  /**
   * Build-time env for a deployment: its own vars with ${{shared.KEY}} expanded
   * against the environment's shared vars, matching what the runtime pod gets,
   * plus the RAILPACK_* overrides derived from its build settings.
   *
   * The build path used to read the raw stored values, so a referenced shared
   * var reached the builder as the literal string `${{shared.API_URL}}` — and
   * for a framework build that string gets baked into the client bundle.
   *
   * The RAILPACK_* overrides are deliberately assembled here rather than
   * threaded through the call chain: every trigger (create, rebuild, webhook
   * auto-deploy, `orchard up`) reads the same deployment row, so they cannot
   * drift apart the way `buildFromRoot` has to be passed at four separate
   * sites. They never become DeploymentEnvVar rows, so they stay out of the
   * runtime pod and the Environment tab.
   */
  private async loadBuildEnv(
    deploymentId: string | undefined,
    buildType?: string
  ): Promise<Record<string, string>> {
    if (!deploymentId) return {};

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          environmentId: true,
          installCommand: true,
          buildCommand: true,
          startCommand: true,
          outputDirectory: true,
          envVars: { select: { key: true, value: true, secret: true } }
        }
      });
      if (!deployment) return {};

      const sharedRows = deployment.environmentId
        ? await this.prisma.environmentSharedVar.findMany({
            where: { environmentId: deployment.environmentId },
            select: { key: true, value: true, secret: true }
          })
        : [];
      // Secret values are encrypted at rest — decrypt before resolving.
      const shared = sharedRows.map((v) => this.secretCrypto.maybeDecrypt(v));

      const { resolved, errors } = resolveEnvVars(
        deployment.envVars.map((v) => this.secretCrypto.maybeDecrypt(v)),
        shared
      );
      for (const e of errors) {
        await this.appendLog(
          deploymentId,
          `Environment variable ${e.key} references unknown shared variable ${e.missingRef}; it resolved to an empty string`,
          'WARNING'
        );
      }

      const env = Object.fromEntries(resolved.map((v) => [v.key, v.value]));

      // Only Railpack reads these; on a Dockerfile build they would just be
      // dead build args.
      if (buildType === 'railpack') {
        Object.assign(env, railpackOverrideEnv(deployment));
      }

      return env;
    } catch (error) {
      console.error('[Docker Service] Failed to resolve build env vars:', {
        deploymentId,
        error: error.message
      });
      return {};
    }
  }

  private async loginPullRegistries(
    envVars: Record<string, string>,
    deploymentId?: string
  ): Promise<void> {
    let auths: RegistryAuths;
    try {
      auths = this.registryCredentials
        ? await this.registryCredentials.buildAuths(deploymentId, envVars)
        : pullAuthsFromEnv(envVars);
    } catch (error) {
      if (error instanceof PullAuthError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    if (!hasRegistryAuths(auths)) return;

    await this.appendLog(deploymentId, 'Using registry credentials to pull base images');
    for (const [host, auth] of Object.entries(auths)) {
      await new Promise<void>((resolve, reject) => {
        const loginProcess = spawn(
          'docker',
          ['login', host, '-u', auth.username, '--password-stdin'],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
              PATH:
                process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
            }
          }
        );
        const stderrChunks: Buffer[] = [];
        loginProcess.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
        loginProcess.on('error', reject);
        loginProcess.on('close', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(Buffer.concat(stderrChunks).toString('utf8') || `Exit ${code ?? signal}`)
            );
        });
        loginProcess.stdin?.end(auth.password, 'utf8');
      }).catch(async (error) => {
        const errorMsg = `Failed to login to ${host}: ${error.message}`;
        await this.appendLog(deploymentId, errorMsg, 'ERROR');
        throw new BadRequestException(errorMsg);
      });
    }
  }

  private async appendLog(
    deploymentId: string | undefined,
    message: string,
    level: 'INFO' | 'ERROR' | 'WARNING' = 'INFO'
  ) {
    if (!deploymentId) return;

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildLogs: true }
      });

      const currentLogs = deployment?.buildLogs || '';
      const timestamp = Date.now();
      const formattedMessage = `[${timestamp}] [${level}] ${message}`;
      const newLogs = `${currentLogs + formattedMessage}\n`;

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildLogs: newLogs }
      });
    } catch (error) {
      console.error('[Docker Service] Failed to append log:', error);
    }
  }

  private async setBuildStep(deploymentId: string | undefined, step: string) {
    if (!deploymentId) return;

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStepTimestamps: true }
      });

      const timestamps = (deployment?.buildStepTimestamps as Record<string, number> | null) || {};
      timestamps[step] = Date.now();

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildStep: step, buildStepTimestamps: timestamps }
      });
    } catch (error) {
      console.error('[Docker Service] Failed to set build step:', error);
    }
  }

  private async computeSecretsHash(deploymentId?: string): Promise<string> {
    const secrets: string[] = [];

    if (deploymentId) {
      try {
        const deployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { envVars: true }
        });

        if (deployment?.envVars && Array.isArray(deployment.envVars)) {
          for (const envVar of deployment.envVars) {
            // Masking works on what the build actually sees, so a secret has to
            // be back in plaintext here or the log would leak the value this
            // list exists to hide.
            const value = this.secretCrypto.maybeDecrypt(envVar).value;
            if (value && typeof value === 'string') {
              secrets.push(`${envVar.key}=${value}`);
            }
          }
        }
      } catch (error) {
        console.error('[Docker Service] Failed to get deployment secrets:', error);
      }
    }

    if (secrets.length === 0) {
      return '';
    }

    const secretsString = secrets.sort().join('\n');
    return crypto.createHash('sha256').update(secretsString).digest('hex');
  }

  // Git prints the full remote URL (credentials included) in failure
  // messages like `fatal: unable to access 'https://x-access-token:ghs_...@...'`.
  // Anything derived from clone output must pass through here before it can
  // reach build logs, which are mirrored to GitHub check runs on the repo.
  private redactCloneSecrets(text: string, accessToken?: string): string {
    let out = redactUrlUserinfo(text);
    if (accessToken) out = out.split(accessToken).join('***');
    const cred = decodeCloneCredential(accessToken);
    if (cred?.password) out = out.split(cred.password).join('***');
    return out;
  }

  async cloneRepository(
    repoUrl: string,
    branch: string,
    accessToken?: string,
    deploymentId?: string
  ): Promise<string> {
    // git treats argv entries that start with `-` as options even when
    // they're positionally an argument (notably `--branch <ref>` accepts
    // `--upload-pack=<cmd>`-shaped values in some versions, and refspec
    // parsing has had RCEs historically). Refuse anything that isn't a
    // valid ref name before it reaches argv.
    if (!isSafeGitRef(branch)) {
      throw new Error(`Invalid branch name: ${branch}`);
    }
    const parsedRepo = parseRepoUrl(repoUrl);
    if (!parsedRepo) {
      throw new Error('Repository URL must be a plain https:// URL');
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchard-build-'));

    const cloneUrl = withCloneCredentials(parsedRepo, accessToken);

    const startTime = Date.now();
    await this.setBuildStep(deploymentId, 'cloning');
    await this.appendLog(deploymentId, `Cloning repository ${repoUrl} (branch: ${branch})...`);

    return new Promise((resolve, reject) => {
      const cloneProcess = spawn(
        'git',
        [
          'clone',
          '--progress',
          '--depth',
          '1',
          '--recurse-submodules',
          '--shallow-submodules',
          '--branch',
          branch,
          cloneUrl,
          tempDir
        ],
        {
          env: {
            ...process.env,
            PATH:
              process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            GIT_TERMINAL_PROMPT: '0'
          }
        }
      );

      let _stdout = '';
      let stderr = '';
      let totalObjects = 0;
      let receivedObjects = 0;
      let totalSize = 0;
      let receivedSize = 0;
      let lastProgressUpdate = Date.now();

      cloneProcess.stderr.on('data', async (data) => {
        const message = data.toString();
        stderr += message;
        console.log('[Git Clone]', message.trim());

        const lines = message.split('\n');
        for (const line of lines) {
          if (line.includes('remote: Counting objects')) {
            const match = line.match(/(\d+)/);
            if (match) {
              totalObjects = parseInt(match[1], 10);
              await this.appendLog(deploymentId, `Counting objects: ${totalObjects}`);
            }
          } else if (line.includes('remote: Compressing objects')) {
            const match = line.match(/(\d+)%/);
            if (match) {
              const percent = match[1];
              await this.appendLog(deploymentId, `Compressing objects: ${percent}%`);
            }
          } else if (line.includes('Receiving objects')) {
            const match = line.match(
              /(\d+)%\s*\((\d+)\/(\d+)\)\s*\|?\s*([\d.]+\s*[KMGT]?i?B)\/?\s*([\d.]+\s*[KMGT]?i?B\/s)?/
            );
            if (match) {
              receivedObjects = parseInt(match[2], 10);
              totalObjects = parseInt(match[3], 10);
              const receivedSizeStr = match[4];
              receivedSize = this.parseSize(receivedSizeStr);

              if (match[5]) {
                const speed = match[5].trim();
                const progress = totalObjects > 0 ? (receivedObjects / totalObjects) * 100 : 0;
                const progressBar = this.createProgressBar(progress);

                const now = Date.now();
                if (now - lastProgressUpdate > 500) {
                  const remainingMB = (totalSize - receivedSize) / (1024 * 1024);
                  const remainingMsg =
                    totalSize > receivedSize ? ` (${remainingMB.toFixed(2)} MB remaining)` : '';
                  await this.appendLog(
                    deploymentId,
                    `Receiving objects: ${progressBar} ${progress.toFixed(1)}% (${receivedObjects}/${totalObjects}) ${receivedSizeStr} @ ${speed}${remainingMsg}`
                  );
                  lastProgressUpdate = now;
                }
              }
            }
            const sizeMatch = line.match(
              /Receiving objects:\s*\d+%\s*\([\d/]+\)\s*\|?\s*[\d.]+\s*([KMGT]?i?B)\s*\|?\s*([\d.]+)\s*([KMGT]?i?B)/
            );
            if (sizeMatch) {
              const totalSizeStr = sizeMatch[2] + sizeMatch[3];
              totalSize = this.parseSize(totalSizeStr);
            }
          } else if (line.includes('Resolving deltas')) {
            const match = line.match(/(\d+)%\s*\((\d+)\/(\d+)\)/);
            if (match) {
              const percent = match[1];
              const current = match[2];
              const total = match[3];
              await this.appendLog(
                deploymentId,
                `Resolving deltas: ${percent}% (${current}/${total})`
              );
            }
          } else if (line.trim() && !line.includes('Cloning into')) {
            await this.appendLog(deploymentId, this.redactCloneSecrets(line.trim(), accessToken));
          }
        }
      });

      cloneProcess.stdout.on('data', async (data) => {
        const message = data.toString();
        _stdout += message;
      });

      cloneProcess.on('close', async (code) => {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

        if (code === 0) {
          const successMsg = `Repository cloned successfully in ${elapsedTime}s`;
          console.log('[Git Clone]', successMsg);
          await this.appendLog(deploymentId, successMsg);
          resolve(tempDir);
        } else {
          const errorMsg = `Failed to clone repository (took ${elapsedTime}s): ${this.redactCloneSecrets(stderr, accessToken) || 'Unknown error'}`;
          await this.appendLog(deploymentId, errorMsg, 'ERROR');
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
          reject(new BadRequestException(errorMsg));
        }
      });

      cloneProcess.on('error', async (error) => {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const errorMsg = `Failed to start git clone (took ${elapsedTime}s): ${error.message}`;
        await this.appendLog(deploymentId, errorMsg, 'ERROR');
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        reject(new BadRequestException(errorMsg));
      });
    });
  }

  private async resolveGitSha(buildDir: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('git', ['-C', buildDir, 'rev-parse', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let out = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
      proc.on('error', () => resolve(null));
    });
  }

  private async injectGitShaBuildArg(
    buildDir: string,
    envVars: Record<string, string>
  ): Promise<void> {
    if ('GIT_SHA' in envVars) return;
    const gitSha = await this.resolveGitSha(buildDir);
    if (gitSha) envVars.GIT_SHA = gitSha;
  }

  async buildImage(
    buildDir: string,
    dockerfilePath: string,
    imageName: string,
    deploymentId?: string,
    target?: string,
    buildFromRoot?: boolean
  ): Promise<void> {
    const fullImageName = `${this.harborRegistryPush}/${this.harborProject}/${imageName}`;
    const dockerfileFull = path.join(buildDir, dockerfilePath);

    const dockerfileExists = await fs
      .access(dockerfileFull)
      .then(() => true)
      .catch(() => false);
    if (!dockerfileExists) {
      const errorMsg = `Dockerfile not found at ${dockerfilePath}`;
      await this.appendLog(deploymentId, errorMsg, 'ERROR');
      throw new BadRequestException(errorMsg);
    }

    const envVars = await this.loadBuildEnv(deploymentId);
    await this.loginPullRegistries(envVars, deploymentId);

    await this.injectGitShaBuildArg(buildDir, envVars);

    const startTime = Date.now();
    await this.setBuildStep(deploymentId, 'building');
    const targetMsg = target ? ` (target: ${target})` : '';
    await this.appendLog(
      deploymentId,
      `Building image ${fullImageName} for ${BUILD_PLATFORM} using Docker${targetMsg}...`
    );

    return new Promise((resolve, reject) => {
      const buildContext = buildFromRoot
        ? buildDir
        : path.dirname(path.join(buildDir, dockerfilePath));
      const dockerfileArg = buildFromRoot ? dockerfilePath : path.basename(dockerfilePath);

      const buildArgs = [
        'build',
        '--progress=plain',
        '--platform',
        BUILD_PLATFORM,
        '-t',
        fullImageName,
        '-f',
        dockerfileArg
      ];
      if (target) {
        buildArgs.push('--target', target);
      }

      for (const [key, value] of Object.entries(envVars)) {
        if (value !== undefined && value !== null && !isPullAuthEnvKey(key)) {
          buildArgs.push('--build-arg', `${key}=${value}`);
        }
      }
      if (!('BUILDKIT_DOCKERFILE_CHECK' in envVars)) {
        buildArgs.push('--build-arg', 'BUILDKIT_DOCKERFILE_CHECK=skip=SecretsUsedInArgOrEnv');
      }

      buildArgs.push('.');

      const buildProcess = spawn('docker', buildArgs, {
        cwd: buildContext,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
          NO_PROXY: `${process.env.NO_PROXY || ''},${this.registryNoProxy}`.replace(/^,/, ''),
          no_proxy: `${process.env.no_proxy || ''},${this.registryNoProxy}`.replace(/^,/, ''),
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        }
      });

      let stdout = '';
      let stderr = '';
      const layerProgress = new Map<string, { current: number; total: number; step?: number }>();
      const stepProgress = new Map<number, { name: string; status: string }>();
      let currentStep = 0;
      let lastProgressUpdate = Date.now();
      let totalSteps = 0;

      const processBuildOutput = async (message: string) => {
        const lines = message.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          const lowerLine = line.toLowerCase();
          let logLevel: 'INFO' | 'ERROR' | 'WARNING' = 'INFO';
          let shouldLog = false;

          if (
            (line.includes('#') &&
              (line.includes('FROM') ||
                line.includes('RUN') ||
                line.includes('COPY') ||
                line.includes('ADD') ||
                line.includes('WORKDIR') ||
                line.includes('ENV') ||
                line.includes('EXPOSE') ||
                line.includes('CMD') ||
                line.includes('ENTRYPOINT'))) ||
            line.startsWith('#')
          ) {
            const stepMatch = line.match(/#(\d+)\s+(.+)/);
            if (stepMatch) {
              const stepNum = parseInt(stepMatch[1], 10);
              const stepName = stepMatch[2].trim();
              currentStep = stepNum;
              totalSteps = Math.max(totalSteps, stepNum);
              stepProgress.set(stepNum, { name: stepName, status: 'running' });
              const stepInfo = totalSteps > 0 ? `${stepNum}/${totalSteps}` : stepNum.toString();
              await this.appendLog(deploymentId, `Step ${stepInfo}: ${stepName}`);
            }
          } else if (line.includes('Step') && line.includes('/')) {
            const stepMatch = line.match(/Step\s+(\d+)\/(\d+)/);
            if (stepMatch) {
              const [, step, total] = stepMatch;
              totalSteps = parseInt(total, 10);
              currentStep = parseInt(step, 10);
              const progress = (currentStep / totalSteps) * 100;
              const progressBar = this.createProgressBar(progress);
              await this.appendLog(
                deploymentId,
                `Build progress: ${progressBar} ${progress.toFixed(1)}% (Step ${step}/${total})`
              );
            }
          } else if (line.includes('Pulling') || line.includes('Downloading')) {
            await this.appendLog(deploymentId, line.trim());
          } else if (
            line.includes('Pull complete') ||
            line.includes('Download complete') ||
            line.includes('Extracting')
          ) {
            const layerMatch = line.match(/([a-f0-9]+):/);
            if (layerMatch) {
              const layerId = layerMatch[1];
              const entry = layerProgress.get(layerId);
              if (entry) {
                layerProgress.set(layerId, {
                  current: entry.total,
                  total: entry.total,
                  step: entry.step
                });
              }
            }
            await this.appendLog(deploymentId, line.trim());
          } else if (line.includes('CACHED') || line.includes('DONE')) {
            const stepMatch = line.match(/#(\d+)/);
            if (stepMatch) {
              const stepNum = parseInt(stepMatch[1], 10);
              const existing = stepProgress.get(stepNum);
              if (existing) {
                existing.status = 'completed';
              }
            }
            await this.appendLog(deploymentId, line.trim());
          } else {
            shouldLog = true;
            if (
              lowerLine.includes('error') ||
              lowerLine.includes('failed') ||
              lowerLine.includes('fatal')
            ) {
              logLevel = 'ERROR';
            } else if (
              lowerLine.includes('warn') ||
              lowerLine.includes('warning') ||
              lowerLine.includes('[warning]')
            ) {
              logLevel = 'WARNING';
            }
          }

          const pullingMatch = line.match(
            /([a-f0-9]+):\s*Pulling\s+fs layer.*?(\d+\.?\d*[KMGB]*B)\/(\d+\.?\d*[KMGB]*B)/
          );
          if (pullingMatch) {
            const [, layerId, currentStr, totalStr] = pullingMatch;
            const current = this.parseSize(currentStr);
            const total = this.parseSize(totalStr);
            layerProgress.set(layerId, { current, total, step: currentStep });
          }

          const downloadingMatch = line.match(
            /([a-f0-9]+):\s*Downloading.*?(\d+\.?\d*[KMGB]*B)\/(\d+\.?\d*[KMGB]*B)/
          );
          if (downloadingMatch) {
            const [, layerId, currentStr, totalStr] = downloadingMatch;
            const current = this.parseSize(currentStr);
            const total = this.parseSize(totalStr);
            const existing = layerProgress.get(layerId) || {
              current: 0,
              total: 0,
              step: currentStep
            };
            layerProgress.set(layerId, { current, total, step: existing.step || currentStep });
          }

          if (shouldLog && !line.match(/^sha256:/) && !line.match(/^\d+\.\d+\s/)) {
            await this.appendLog(deploymentId, line.trim(), logLevel);
          }
        }
      };

      buildProcess.stdout.on('data', async (data) => {
        const message = data.toString();
        stdout += message;
        console.log('[Docker Build]', message.trim());
        await processBuildOutput(message);
      });

      buildProcess.stderr.on('data', async (data) => {
        const message = data.toString();
        stderr += message;
        console.log('[Docker Build]', message.trim());
        await processBuildOutput(message);

        const now = Date.now();
        if (now - lastProgressUpdate > 1000 && layerProgress.size > 0) {
          const totalCurrent = Array.from(layerProgress.values()).reduce(
            (sum, l) => sum + l.current,
            0
          );
          const totalSize = Array.from(layerProgress.values()).reduce((sum, l) => sum + l.total, 0);

          if (totalSize > 0) {
            const progress = (totalCurrent / totalSize) * 100;
            const remainingMB = (totalSize - totalCurrent) / (1024 * 1024);
            const progressBar = this.createProgressBar(progress);
            const stepProgressInfo =
              totalSteps > 0 && currentStep > 0 ? ` (Step ${currentStep}/${totalSteps})` : '';
            await this.appendLog(
              deploymentId,
              `Downloading layers: ${progressBar} ${progress.toFixed(1)}%${stepProgressInfo} (${remainingMB.toFixed(2)} MB remaining)`
            );
          }
          lastProgressUpdate = now;
        }
      });

      buildProcess.on('close', async (code) => {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

        if (code === 0) {
          const successMsg = `Successfully built image: ${fullImageName} (took ${elapsedTime}s)`;
          console.log('[Docker Build]', successMsg);
          await this.appendLog(deploymentId, successMsg);
          resolve();
        } else {
          const errorMsg = `Docker build failed with code ${code} (took ${elapsedTime}s)`;
          await this.appendLog(deploymentId, errorMsg, 'ERROR');
          if (stderr) await this.appendLog(deploymentId, stderr, 'ERROR');
          reject(new BadRequestException(`${errorMsg}: ${stderr || stdout}`));
        }
      });

      buildProcess.on('error', async (error) => {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const errorMsg = `Failed to start docker build (took ${elapsedTime}s): ${error.message}`;
        await this.appendLog(deploymentId, errorMsg, 'ERROR');
        reject(new BadRequestException(errorMsg));
      });
    });
  }

  async buildImageWithDepot(
    buildDir: string,
    dockerfilePath: string,
    imageName: string,
    deploymentId?: string,
    target?: string,
    buildFromRoot?: boolean,
    _buildType?: string
  ): Promise<void> {
    const fullImageName = `${this.harborRegistryPull}/${this.harborProject}/${imageName}`;

    const envVars = await this.loadBuildEnv(deploymentId);
    await this.loginPullRegistries(envVars, deploymentId);

    await this.injectGitShaBuildArg(buildDir, envVars);

    const startTime = Date.now();
    await this.setBuildStep(deploymentId, 'building');
    await this.appendLog(deploymentId, `Building image ${fullImageName} using Super Builds...`);

    return new Promise((resolve, reject) => {
      const buildContext = buildFromRoot
        ? buildDir
        : path.dirname(path.join(buildDir, dockerfilePath));
      const dockerfileArg = buildFromRoot ? dockerfilePath : path.basename(dockerfilePath);

      const depotArgs = [
        'build',
        '--progress=plain',
        '--platform',
        BUILD_PLATFORM,
        '-t',
        fullImageName,
        '-f',
        dockerfileArg,
        '--push'
      ];
      if (target) {
        depotArgs.push('--target', target);
      }
      for (const [key, value] of Object.entries(envVars)) {
        if (value !== undefined && value !== null) {
          depotArgs.push('--build-arg', `${key}=${value}`);
        }
      }
      if (!('BUILDKIT_DOCKERFILE_CHECK' in envVars)) {
        depotArgs.push('--build-arg', 'BUILDKIT_DOCKERFILE_CHECK=skip=SecretsUsedInArgOrEnv');
      }
      depotArgs.push('.');

      console.log('[Docker Service] Running depot build:', {
        args: depotArgs.map((a) => (a.startsWith('--build-arg') ? '--build-arg' : a)),
        cwd: buildContext
      });

      const buildProcess = spawn('depot', depotArgs, {
        cwd: buildContext,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DEPOT_TOKEN: process.env.DEPOT_TOKEN || '',
          DEPOT_PROJECT_ID: process.env.DEPOT_PROJECT_ID || '',
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        }
      });

      let stdout = '';
      let stderr = '';

      const rebrandLine = (line: string): string =>
        line
          .replace(/\[depot\]/gi, '[super-build]')
          .replace(/https:\/\/depot\.dev\/\S+/g, '')
          .replace(/depot build/gi, 'super build')
          .trim();

      buildProcess.stdout.on('data', async (data: Buffer) => {
        const message = data.toString();
        stdout += message;
        for (const line of message.split('\n')) {
          const rebranded = rebrandLine(line);
          if (rebranded) {
            await this.appendLog(deploymentId, rebranded);
          }
        }
      });

      buildProcess.stderr.on('data', async (data: Buffer) => {
        const message = data.toString();
        stderr += message;
        for (const line of message.split('\n')) {
          const rebranded = rebrandLine(line);
          if (rebranded) {
            await this.appendLog(deploymentId, rebranded);
          }
        }
      });

      buildProcess.on('close', async (code) => {
        const duration = Math.floor((Date.now() - startTime) / 1000);
        if (code === 0) {
          await this.appendLog(deploymentId, `Super Build completed in ${duration}s`);
          resolve();
        } else {
          const errorMsg = `Super Build failed with exit code ${code}:\n${stderr || stdout}`;
          await this.appendLog(deploymentId, errorMsg, 'ERROR');
          reject(new Error(errorMsg));
        }
      });

      buildProcess.on('error', async (err) => {
        const errorMsg = `Failed to start Super Build process: ${err.message}. Is the build CLI installed?`;
        await this.appendLog(deploymentId, errorMsg, 'ERROR');
        reject(new Error(errorMsg));
      });
    });
  }

  async buildImageWithRailpack(
    buildDir: string,
    imageName: string,
    deploymentId?: string
  ): Promise<void> {
    const fullImageName = `${this.harborRegistryPush}/${this.harborProject}/${imageName}`;

    const startTime = Date.now();
    await this.setBuildStep(deploymentId, 'building');
    await this.appendLog(
      deploymentId,
      `Building image ${fullImageName} for ${BUILD_PLATFORM} using Railpack...`
    );

    const planPath = path.join(buildDir, 'railpack-plan.json');
    const infoPath = path.join(buildDir, 'railpack-info.json');

    await this.appendLog(deploymentId, 'Preparing build with Railpack...');

    const envVars = await this.loadBuildEnv(deploymentId, 'railpack');
    await this.loginPullRegistries(envVars, deploymentId);

    try {
      const prepareArgs = ['prepare', buildDir, '--plan-out', planPath, '--info-out', infoPath];

      for (const [key, value] of Object.entries(envVars)) {
        if (value && typeof value === 'string') {
          prepareArgs.push('--env', `${key}=${value}`);
        }
      }

      await new Promise<void>((resolve, reject) => {
        const prepareProcess = spawn('railpack', prepareArgs, {
          cwd: buildDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
          }
        });

        let stdout = '';
        let stderr = '';

        prepareProcess.stdout.on('data', async (data) => {
          const message = data.toString();
          stdout += message;
          await this.appendLog(deploymentId, message.trim());
        });

        prepareProcess.stderr.on('data', async (data) => {
          const message = data.toString();
          stderr += message;
          await this.appendLog(deploymentId, message.trim());
        });

        prepareProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Railpack prepare failed with code ${code}: ${stderr || stdout}`));
          }
        });

        prepareProcess.on('error', (error) => {
          reject(new Error(`Failed to start railpack prepare: ${error.message}`));
        });
      });

      await this.appendLog(deploymentId, 'Build plan generated successfully');

      // The local path writes railpack-info.json straight to disk, so it can be
      // read directly rather than scraped back out of a log.
      if (deploymentId) {
        try {
          const detection = parseRailpackInfo(
            RAILPACK_INFO_MARKER + (await fs.readFile(infoPath, 'utf8')).replace(/\n/g, '')
          );
          if (detection) {
            await this.prisma.deployment.update({
              where: { id: deploymentId },
              data: { detectedConfig: detection as unknown as object }
            });
          }
        } catch {
          // Detection metadata is a nicety; never fail a good build over it.
        }
      }
    } catch (error) {
      const errorMsg = `Failed to prepare build with Railpack: ${error.message}`;
      await this.appendLog(deploymentId, errorMsg, 'ERROR');
      throw new BadRequestException(errorMsg);
    }

    const secretsHash = await this.computeSecretsHash(deploymentId);

    return new Promise((resolve, reject) => {
      const buildArgs = [
        'buildx',
        'build',
        '--progress=plain',
        '--platform',
        BUILD_PLATFORM,
        '-t',
        fullImageName,
        '--build-arg',
        `BUILDKIT_SYNTAX=${this.railpackFrontendImage}`,
        '-f',
        planPath
      ];

      if (secretsHash) {
        buildArgs.push('--build-arg', `secrets-hash=${secretsHash}`);
      }

      for (const [key, value] of Object.entries(envVars)) {
        if (value && typeof value === 'string' && !isPullAuthEnvKey(key)) {
          buildArgs.push('--secret', `id=${key},env=${key}`);
        }
      }

      buildArgs.push('--output', 'type=docker', buildDir);

      const buildEnv = {
        ...process.env,
        ...envVars,
        DOCKER_BUILDKIT: '1',
        DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
        NO_PROXY: `${process.env.NO_PROXY || ''},${this.registryNoProxy},ghcr.io`.replace(/^,/, ''),
        no_proxy: `${process.env.no_proxy || ''},${this.registryNoProxy},ghcr.io`.replace(/^,/, ''),
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      };

      const buildProcess = spawn('docker', buildArgs, {
        cwd: buildDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildEnv
      });

      let stdout = '';
      let stderr = '';
      let lastProgressUpdate = Date.now();
      let currentStep = 0;
      let totalSteps = 0;

      const processRailpackOutput = async (message: string) => {
        const lines = message.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          const lowerLine = line.toLowerCase();
          let logLevel: 'INFO' | 'ERROR' | 'WARNING' = 'INFO';
          let shouldLog = false;

          // Railpack/BuildKit outputs build steps and progress info
          if (line.includes('#') && (line.includes('[') || line.match(/#\d+/))) {
            const stepMatch = line.match(/#(\d+)\s+(.+)/);
            if (stepMatch) {
              const stepNum = parseInt(stepMatch[1], 10);
              const stepName = stepMatch[2].trim();
              currentStep = stepNum;
              totalSteps = Math.max(totalSteps, stepNum);
              await this.appendLog(deploymentId, `Step ${stepNum}: ${stepName}`);
            }
          } else if (line.includes('Step') && line.includes('/')) {
            const stepMatch = line.match(/Step\s+(\d+)\/(\d+)/);
            if (stepMatch) {
              const [, step, total] = stepMatch;
              totalSteps = parseInt(total, 10);
              currentStep = parseInt(step, 10);
              const progress = (currentStep / totalSteps) * 100;
              const progressBar = this.createProgressBar(progress);
              await this.appendLog(
                deploymentId,
                `Build progress: ${progressBar} ${progress.toFixed(1)}% (Step ${step}/${total})`
              );
            }
          }

          // Check for Railpack-specific output
          if (
            lowerLine.includes('detected') ||
            lowerLine.includes('installing') ||
            lowerLine.includes('railpack')
          ) {
            await this.appendLog(deploymentId, line.trim());
          } else if (
            lowerLine.includes('error') ||
            lowerLine.includes('failed') ||
            lowerLine.includes('fatal')
          ) {
            logLevel = 'ERROR';
            await this.appendLog(deploymentId, line.trim(), logLevel);
          } else if (lowerLine.includes('warn') || lowerLine.includes('warning')) {
            logLevel = 'WARNING';
            await this.appendLog(deploymentId, line.trim(), logLevel);
          } else if (
            lowerLine.includes('done') ||
            lowerLine.includes('complete') ||
            lowerLine.includes('cached') ||
            lowerLine.includes('exporting')
          ) {
            await this.appendLog(deploymentId, line.trim());
          } else if (line.includes('CACHED') || line.includes('DONE')) {
            await this.appendLog(deploymentId, line.trim());
          } else {
            shouldLog = true;
          }

          // Log other output but throttle to avoid spam
          if (shouldLog && !line.match(/^sha256:/) && !line.match(/^\d+\.\d+\s/)) {
            const now = Date.now();
            if (now - lastProgressUpdate > 500) {
              await this.appendLog(deploymentId, line.trim());
              lastProgressUpdate = now;
            }
          }
        }
      };

      buildProcess.stdout.on('data', async (data) => {
        const message = data.toString();
        stdout += message;
        console.log('[Railpack Build]', message.trim());
        await processRailpackOutput(message);
      });

      buildProcess.stderr.on('data', async (data) => {
        const message = data.toString();
        stderr += message;
        console.log('[Railpack Build]', message.trim());
        await processRailpackOutput(message);
      });

      buildProcess.on('close', async (code) => {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

        await fs.unlink(planPath).catch(() => {});
        await fs.unlink(infoPath).catch(() => {});

        if (code === 0) {
          const successMsg = `Successfully built image with Railpack: ${fullImageName} (took ${elapsedTime}s)`;
          console.log('[Railpack Build]', successMsg);
          await this.appendLog(deploymentId, successMsg);
          resolve();
        } else {
          const errorMsg = `Railpack build failed with code ${code} (took ${elapsedTime}s)`;
          await this.appendLog(deploymentId, errorMsg, 'ERROR');
          if (stderr) await this.appendLog(deploymentId, stderr, 'ERROR');
          reject(new BadRequestException(`${errorMsg}: ${stderr || stdout}`));
        }
      });

      buildProcess.on('error', async (error) => {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        await fs.unlink(planPath).catch(() => {});
        await fs.unlink(infoPath).catch(() => {});
        const errorMsg = `Failed to start railpack build (took ${elapsedTime}s): ${error.message}`;
        await this.appendLog(deploymentId, errorMsg, 'ERROR');
        reject(new BadRequestException(errorMsg));
      });
    });
  }

  async pushImage(imageName: string, deploymentId?: string): Promise<void> {
    const fullImageName = `${this.harborRegistryPush}/${this.harborProject}/${imageName}`;
    const maxRetries = 3;

    await this.setBuildStep(deploymentId, 'pushing');

    const harborUsername = process.env.HARBOR_USERNAME;
    const harborPassword = process.env.HARBOR_PASSWORD;

    if (harborUsername && harborPassword) {
      await this.appendLog(deploymentId, `Logging in to registry ${this.harborRegistryPush}...`);
      try {
        await new Promise<void>((resolve, reject) => {
          const loginProcess = spawn(
            'docker',
            ['login', this.harborRegistryPush, '-u', harborUsername, '--password-stdin'],
            {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: {
                ...process.env,
                DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
                PATH:
                  process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
              }
            }
          );
          const stderrChunks: Buffer[] = [];
          loginProcess.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
          loginProcess.on('error', reject);
          loginProcess.on('close', (code, signal) => {
            if (code === 0) resolve();
            else
              reject(
                new Error(Buffer.concat(stderrChunks).toString('utf8') || `Exit ${code ?? signal}`)
              );
          });
          loginProcess.stdin?.end(harborPassword, 'utf8');
        });
        await this.appendLog(deploymentId, `Successfully logged in to registry`);
      } catch (error) {
        const errorMsg = `Failed to login to registry: ${error.message}`;
        await this.appendLog(deploymentId, errorMsg, 'ERROR');
        throw new BadRequestException(errorMsg);
      }
    } else {
      await this.appendLog(
        deploymentId,
        `No registry credentials found, attempting anonymous push...`,
        'WARNING'
      );
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      const attemptMsg = attempt > 1 ? ` (attempt ${attempt}/${maxRetries})` : '';
      await this.appendLog(
        deploymentId,
        `Pushing image to ${this.harborRegistryPush} using Docker${attemptMsg}...`
      );

      try {
        await new Promise<void>((resolve, reject) => {
          const pushProcess = spawn('docker', ['push', fullImageName], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
              NO_PROXY: `${process.env.NO_PROXY || ''},${this.registryNoProxy}`.replace(/^,/, ''),
              no_proxy: `${process.env.no_proxy || ''},${this.registryNoProxy}`.replace(/^,/, ''),
              HTTP_PROXY: '',
              HTTPS_PROXY: '',
              http_proxy: '',
              https_proxy: '',
              PATH:
                process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
            }
          });

          let stdout = '';
          let stderr = '';
          const layerProgress = new Map<string, { current: number; total: number }>();
          let lastProgressUpdate = Date.now();

          pushProcess.stdout.on('data', async (data) => {
            const message = data.toString();
            stdout += message;

            const lines = message.split('\n');
            for (const line of lines) {
              if (line.includes('Pushing') && line.includes('/')) {
                const match = line.match(
                  /([a-f0-9]+):\s*Pushing.*?(\d+\.?\d*[KMGB]*B)\/(\d+\.?\d*[KMGB]*B)/
                );
                if (match) {
                  const [, layerId, currentStr, totalStr] = match;
                  const current = this.parseSize(currentStr);
                  const total = this.parseSize(totalStr);
                  layerProgress.set(layerId, { current, total });
                }
              } else if (line.includes('Pushed') && line.match(/^[a-f0-9]+: Pushed/)) {
                const layerId = line.split(':')[0];
                const entry = layerProgress.get(layerId);
                if (entry) {
                  layerProgress.set(layerId, { current: entry.total, total: entry.total });
                }
              }
            }

            const now = Date.now();
            if (now - lastProgressUpdate > 1000) {
              const progress = this.calculatePushProgress(layerProgress);
              const totalCurrent = Array.from(layerProgress.values()).reduce(
                (sum, l) => sum + l.current,
                0
              );
              const totalSize = Array.from(layerProgress.values()).reduce(
                (sum, l) => sum + l.total,
                0
              );

              if (totalSize > 0 && progress > 0) {
                const pushedMB = (totalCurrent / (1024 * 1024)).toFixed(2);
                const totalMB = (totalSize / (1024 * 1024)).toFixed(2);
                const remainingMB = ((totalSize - totalCurrent) / (1024 * 1024)).toFixed(2);
                const progressBar = this.createProgressBar(progress);
                await this.appendLog(
                  deploymentId,
                  `Push progress: ${progressBar} ${progress.toFixed(1)}% (${pushedMB} MB / ${totalMB} MB pushed, ${remainingMB} MB remaining)`
                );
              }
              lastProgressUpdate = now;
            }

            console.log('[Docker Push]', message.trim());
          });

          pushProcess.stderr.on('data', async (data) => {
            const message = data.toString();
            stderr += message;
            console.error('[Docker Push Error]', message.trim());
            const lowerMessage = message.toLowerCase();
            let logLevel: 'ERROR' | 'INFO' | 'WARNING' = 'INFO';
            if (lowerMessage.includes('error') || lowerMessage.includes('failed')) {
              logLevel = 'ERROR';
            } else if (lowerMessage.includes('warn')) {
              logLevel = 'WARNING';
            }
            await this.appendLog(deploymentId, message.trim(), logLevel);
          });

          pushProcess.on('close', async (code) => {
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);

            if (code === 0) {
              const successMsg = `Successfully pushed image: ${fullImageName} (took ${elapsedTime}s)`;
              console.log('[Docker Push]', successMsg);
              await this.appendLog(deploymentId, successMsg);
              resolve();
            } else {
              const errorMsg = `Docker push failed with code ${code} (took ${elapsedTime}s)`;
              await this.appendLog(deploymentId, errorMsg, 'ERROR');
              if (stderr) await this.appendLog(deploymentId, `Error details: ${stderr}`, 'ERROR');
              reject(new BadRequestException(`${errorMsg}: ${stderr || stdout}`));
            }
          });

          pushProcess.on('error', async (error) => {
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
            const errorMsg = `Failed to start docker push (took ${elapsedTime}s): ${error.message}`;
            await this.appendLog(deploymentId, errorMsg, 'ERROR');
            reject(new BadRequestException(errorMsg));
          });
        });

        return;
      } catch (error) {
        lastError = error;

        const isRetryable =
          error.message &&
          (error.message.includes('timeout') ||
            error.message.includes('connection refused') ||
            error.message.includes('connection reset') ||
            error.message.includes('proxyconnect') ||
            error.message.includes('network') ||
            error.message.includes('dial tcp') ||
            error.message.includes('i/o timeout') ||
            error.message.includes('EOF'));

        if (isRetryable && attempt < maxRetries) {
          const waitSeconds = 2 ** attempt;
          await this.appendLog(
            deploymentId,
            `Push failed with retryable error, waiting ${waitSeconds}s before retry...`,
            'WARNING'
          );
          await new Promise((resolve) => {
            setTimeout(resolve, waitSeconds * 1000);
          });
          continue;
        } else {
          throw error;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  getImagePath(imageName: string, tag = 'latest'): string {
    return `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`;
  }

  async buildAndPushFromGitHub(options: BuildOptions): Promise<string> {
    const {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag = 'latest',
      deploymentId,
      buildType = 'dockerfile',
      buildMode = this.defaultBuildMode
    } = options;

    console.log('[Docker Service] buildAndPushFromGitHub called:', {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag,
      deploymentId,
      buildType,
      buildMode,
      defaultBuildMode: this.defaultBuildMode,
      hasImageBuilderService: !!this.imageBuilderService
    });

    if (buildMode === 'kubernetes' && this.imageBuilderService) {
      console.log('[Docker Service] Using Kubernetes build mode');
      return this.buildWithKubernetes(options);
    }

    console.log('[Docker Service] Falling back to local Docker build');
    return this.buildWithLocalDocker(options);
  }

  /**
   * Build using Kubernetes-based BuildKit pods with S3 cache
   */
  private async buildWithKubernetes(options: BuildOptions): Promise<string> {
    const {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag = 'latest',
      deploymentId,
      accessToken,
      target,
      buildFromRoot,
      buildType = 'dockerfile'
    } = options;

    console.log('[Docker Service] buildWithKubernetes called:', {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag,
      deploymentId,
      hasAccessToken: !!accessToken,
      target,
      buildFromRoot,
      buildType
    });

    if (!this.imageBuilderService) {
      const error = 'ImageBuilderService not available for Kubernetes builds';
      console.error('[Docker Service]', error);
      throw new BadRequestException(error);
    }

    await this.appendLog(
      deploymentId,
      `Using Kubernetes BuildKit builder for ${repoUrl}@${branch}`
    );

    const envVars = await this.loadBuildEnv(deploymentId, buildType);
    console.log(
      `[Docker Service] Loaded ${Object.keys(envVars).length} environment variables for deployment ${deploymentId}`
    );

    const rootDirectory =
      buildType === 'railpack' ? await this.loadRootDirectory(deploymentId) : null;

    try {
      const result = await this.imageBuilderService.buildAndPush({
        repoUrl,
        branch,
        dockerfilePath,
        imageName,
        tag,
        rootDirectory,
        deploymentId,
        accessToken,
        target,
        buildFromRoot,
        buildType,
        envVars,
        buildWithDepot: options.buildWithDepot,
        cacheTenantKey: options.cacheTenantKey,
        persistentBuildCache: options.persistentBuildCache,
        localContextUrl: options.localContextUrl,
        builder: options.builder
      });

      console.log('[Docker Service] Build completed successfully:', result);
      return result;
    } catch (error) {
      console.error('[Docker Service] Build failed in buildWithKubernetes:', {
        deploymentId,
        imageName,
        tag,
        error: error.message,
        errorType: error.constructor.name,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Build using local Docker daemon (legacy mode)
   */
  private async buildWithLocalDocker(options: BuildOptions): Promise<string> {
    const {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag = 'latest',
      deploymentId,
      accessToken,
      target,
      buildFromRoot,
      buildType = 'dockerfile'
    } = options;

    const imageFullName = tag ? `${imageName}:${tag}` : imageName;
    let buildDir: string | null = null;
    this.activeBuilds += 1;

    try {
      const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
      await this.appendLog(
        deploymentId,
        `Starting ${buildMethodLabel} build for ${repoUrl}@${branch} (local Docker)`
      );

      buildDir = await this.cloneRepository(repoUrl, branch, accessToken, deploymentId);

      if (options.buildWithDepot) {
        // Depot handles build + push in one step
        await this.buildImageWithDepot(
          buildDir,
          dockerfilePath,
          imageFullName,
          deploymentId,
          target,
          buildFromRoot,
          buildType
        );
      } else if (buildType === 'railpack') {
        // Railpack automatically detects language/framework and builds
        await this.buildImageWithRailpack(buildDir, imageFullName, deploymentId);
      } else {
        // Traditional Dockerfile build
        await this.buildImage(
          buildDir,
          dockerfilePath,
          imageFullName,
          deploymentId,
          target,
          buildFromRoot
        );
      }

      if (!options.buildWithDepot) {
        await this.pushImage(imageFullName, deploymentId);
      }

      const fullImagePath = `${this.harborRegistryPull}/${this.harborProject}/${imageFullName}`;
      await this.appendLog(deploymentId, `Build and push completed successfully!`);
      await this.appendLog(deploymentId, `Image available at: ${fullImagePath}`);

      return fullImagePath;
    } catch (error) {
      const errorMsg = `Build failed: ${error.message}`;
      console.error('[Docker Service]', errorMsg);
      await this.appendLog(deploymentId, errorMsg, 'ERROR');

      // Update deployment with error
      if (deploymentId) {
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'failed',
            buildError: error.message
          }
        });
      }

      throw error;
    } finally {
      this.activeBuilds = Math.max(0, this.activeBuilds - 1);
      if (buildDir) {
        await fs.rm(buildDir, { recursive: true, force: true }).catch((err) => {
          console.error('[Docker Service] Failed to cleanup build directory:', err);
        });
      }
      await this.maybePruneDocker(deploymentId);
    }
  }

  private async maybePruneDocker(deploymentId?: string) {
    const enabled = (process.env.DOCKER_PRUNE_AFTER_BUILD || 'false').toLowerCase() === 'true';
    if (!enabled) return;

    const parsedPruneEvery = Number(process.env.DOCKER_PRUNE_EVERY || '2');
    const pruneEvery = Number.isFinite(parsedPruneEvery) ? Math.max(1, parsedPruneEvery) : 2;
    this.buildsSincePrune += 1;
    if (this.buildsSincePrune >= pruneEvery) {
      this.pendingPrune = true;
    }
    if (!this.pendingPrune || this.activeBuilds > 0) {
      return;
    }

    this.pendingPrune = false;
    this.buildsSincePrune = 0;

    this.pruneLock = this.pruneLock
      .then(() => this.runDockerPrune(deploymentId))
      .catch((error) => {
        console.error('[Docker Service] Prune failed:', error);
      });
    await this.pruneLock;
  }

  private async runDockerPrune(deploymentId?: string) {
    await this.appendLog(deploymentId, 'Pruning Docker build cache and dangling images...');
    const env = {
      ...process.env,
      DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    };
    try {
      await execAsync('docker builder prune -af', { env });
      await execAsync('docker image prune -af', { env });
      await this.appendLog(deploymentId, 'Docker prune completed');
    } catch (error) {
      await this.appendLog(deploymentId, `Docker prune failed: ${error.message}`, 'WARNING');
    }
  }

  private parseSize(sizeStr: string): number {
    const match = sizeStr.match(/(\d+\.?\d*)([KMGB]*B?)/);
    if (!match) return 0;

    const [, num, unit] = match;
    const value = parseFloat(num);

    switch (unit.toUpperCase()) {
      case 'GB':
      case 'G':
        return value * 1024 * 1024 * 1024;
      case 'MB':
      case 'M':
        return value * 1024 * 1024;
      case 'KB':
      case 'K':
        return value * 1024;
      default:
        return value;
    }
  }

  private calculatePushProgress(
    layerProgress: Map<string, { current: number; total: number }>
  ): number {
    if (layerProgress.size === 0) return 0;

    let totalCurrent = 0;
    let totalSize = 0;

    for (const { current, total } of layerProgress.values()) {
      totalCurrent += current;
      totalSize += total;
    }

    return totalSize > 0 ? (totalCurrent / totalSize) * 100 : 0;
  }

  private createProgressBar(percentage: number, width = 30): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}]`;
  }

  /**
   * Delete specific artifacts (tags) from Harbor. Used for pruning old images.
   */
  async deleteArtifactsFromRegistry(images: string[]): Promise<void> {
    if (this.imageBuilderService) {
      await this.imageBuilderService.deleteArtifactsFromRegistry(images);
    } else {
      console.warn(
        '[Docker] ImageBuilderService not available, skipping registry artifact deletion'
      );
    }
  }

  /**
   * Delete entire repositories from Harbor. Used when a deployment is deleted.
   */
  async deleteRepositoriesFromRegistry(images: string[]): Promise<void> {
    if (this.imageBuilderService) {
      await this.imageBuilderService.deleteRepositoriesFromRegistry(images);
    } else {
      console.warn(
        '[Docker] ImageBuilderService not available, skipping registry repository deletion'
      );
    }
  }

  /**
   * Cancel running build jobs for a deployment by deleting the Kubernetes Job and its pods.
   */
  firecrackerBuildStatus(hostId: string, buildId: string) {
    if (!this.imageBuilderService) return Promise.resolve('unknown_host' as const);
    return this.imageBuilderService.firecrackerBuildStatus(hostId, buildId);
  }

  adoptFirecrackerBuild(opts: {
    deploymentId: string;
    hostId: string;
    buildId: string;
    pullRef: string;
    offset: number;
    buildType?: string;
  }): Promise<string> {
    if (!this.imageBuilderService) {
      return Promise.reject(new Error('image builder unavailable'));
    }
    return this.imageBuilderService.adoptFirecrackerBuild(opts);
  }

  async cancelBuildJobsByDeploymentId(deploymentId: string): Promise<void> {
    if (this.imageBuilderService) {
      console.log(`[Docker] Cancelling build jobs for deployment ${deploymentId}`);
      await this.imageBuilderService.cancelBuildJobsByDeploymentId(deploymentId);
      await this.imageBuilderService.cancelFirecrackerBuilds(deploymentId);
    } else {
      console.warn(
        '[Docker] ImageBuilderService not available, cannot cancel Kubernetes build jobs'
      );
    }
  }

  async getBuildJobStatus(jobName: string) {
    if (!this.imageBuilderService) return null;
    return this.imageBuilderService.getBuildJobStatus(jobName);
  }

  async waitForBuildJob(
    jobName: string,
    deploymentId?: string,
    timeoutMs?: number,
    opts?: { expectedImage?: string | null }
  ) {
    if (!this.imageBuilderService) return null;
    return this.imageBuilderService.waitForBuildJob(jobName, deploymentId, timeoutMs, opts);
  }

  async deleteBuildJob(jobName: string): Promise<void> {
    if (!this.imageBuilderService) return;
    await this.imageBuilderService.deleteBuildJob(jobName);
  }

  async findBuildJobsForDeployment(
    deploymentId: string
  ): Promise<{ name: string; image: string | null; status: string }[] | null> {
    if (!this.imageBuilderService) return [];
    return this.imageBuilderService.findBuildJobsForDeployment(deploymentId);
  }

  async imageExistsInRegistry(image: string): Promise<boolean | null> {
    if (!this.imageBuilderService) return null;
    return this.imageBuilderService.imageExistsInRegistry(image);
  }
}
