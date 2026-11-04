import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger
} from '@nestjs/common';
import * as yaml from 'js-yaml';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { DeploymentsService } from '../projects/deployments.service';
import { EnvironmentsService } from '../projects/environments.service';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';
import { GitHubService } from '../github/github.service';
import { looksSecret } from '../projects/env-write-rules';

interface UserData {
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
}

interface CreateFromGithubBody {
  name: string;
  repoUrl: string;
  branch: string;
  composePath?: string;
  autoDeployEnabled?: boolean;
  environmentId?: string;
}

interface ParsedComposeService {
  name: string;
  image?: string;
  build?: { context?: string; dockerfile?: string };
  ports: { containerPort: number; servicePort: number; protocol: string }[];
  env: { key: string; value: string }[];
  volumes: { name: string; type: 'pvc' | 'emptyDir'; mountPath: string; storageSize?: string }[];
  replicas: number;
  // Compose `command:`, normalised to the string Orchard stores. A list is
  // re-encoded as JSON so resolveStartArgs reads it back as an exec form
  // rather than re-splitting arguments that were already split.
  command?: string | null;
  cpuRequestMilli?: number | null;
  memoryRequestBytes?: number | null;
}

function parseComposeCommand(command: unknown): string | null {
  if (Array.isArray(command)) {
    const argv = command.map((arg) => String(arg));
    return argv.length > 0 ? JSON.stringify(argv) : null;
  }
  if (typeof command === 'string') return command.trim() || null;
  return null;
}

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  k: 1000,
  kb: 1000,
  ki: 1024,
  kib: 1024,
  m: 1000 ** 2,
  mb: 1000 ** 2,
  mi: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1000 ** 3,
  gb: 1000 ** 3,
  gi: 1024 ** 3,
  gib: 1024 ** 3
};

function scrubComposeStackForViewer<
  T extends { composeYaml: string; buildLogs: string | null; lastError: string | null }
>(stack: T): T {
  return { ...stack, composeYaml: '', buildLogs: '', lastError: null };
}

const CHILD_SELECT = {
  id: true,
  name: true,
  composeServiceName: true,
  githubRepo: true,
  image: true,
  replicas: true,
  stopped: true,
  cpuRequestMilli: true,
  memoryRequestBytes: true,
  startCommand: true,
  dockerfilePath: true,
  buildFromRoot: true,
  envVars: { select: { key: true, value: true, secret: true } },
  volumes: true,
  services: { select: { id: true, name: true, ports: true } }
} satisfies Prisma.DeploymentSelect;

type ComposeChild = Prisma.DeploymentGetPayload<{ select: typeof CHILD_SELECT }>;

interface PreservedEnv {
  key: string;
  value: string;
  secret: boolean;
}

@Injectable()
export class ComposeStacksService {
  private readonly logger = new Logger(ComposeStacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly deployments: DeploymentsService,
    private readonly environments: EnvironmentsService,
    private readonly authz: AuthorizationService,
    private readonly usersService: UsersService,
    private readonly github: GitHubService
  ) {}

  private async resolveUserId(clerkId: string, userData?: UserData): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    return user.id;
  }

  private formatStackName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 200);
  }

  private parseComposeCpu(value: unknown): number | null {
    if (value == null) return null;
    const cpus = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(cpus) || cpus <= 0) return null;
    return Math.max(1, Math.round(cpus * 1000));
  }

  private parseComposeMemory(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    }
    const match = /^\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)\s*$/.exec(String(value));
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit ? MEMORY_UNITS[unit] : 1;
    if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;
    return Math.round(amount * multiplier);
  }

  private parseComposeResources(svc: any): {
    cpuRequestMilli: number | null;
    memoryRequestBytes: number | null;
  } {
    const limits = svc?.deploy?.resources?.limits ?? {};
    const reservations = svc?.deploy?.resources?.reservations ?? {};
    return {
      // Orchard's cpuRequestMilli/memoryRequestBytes are the pod's ceiling, so
      // compose `limits` wins; `reservations` only fills in what limits omits.
      cpuRequestMilli: this.parseComposeCpu(limits.cpus) ?? this.parseComposeCpu(reservations.cpus),
      memoryRequestBytes:
        this.parseComposeMemory(limits.memory) ?? this.parseComposeMemory(reservations.memory)
    };
  }

  private parseCompose(composeYaml: string): ParsedComposeService[] {
    let parsed: any;
    try {
      parsed = yaml.load(composeYaml);
    } catch (e: any) {
      throw new BadRequestException(`Invalid compose YAML: ${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.services) {
      throw new BadRequestException('Compose file must define a `services` key');
    }
    const services = parsed.services as Record<string, any>;
    if (Object.keys(services).length === 0) {
      throw new BadRequestException('Compose file must define at least one service');
    }

    const volumesTop: Record<string, any> = parsed.volumes ?? {};

    const out: ParsedComposeService[] = [];
    for (const [name, svc] of Object.entries(services)) {
      if (!svc?.image && !svc?.build) {
        throw new BadRequestException(
          `Service "${name}" must have either \`image:\` or \`build:\``
        );
      }

      const ports: ParsedComposeService['ports'] = [];
      for (const p of svc?.ports ?? []) {
        const portStr = typeof p === 'string' ? p : `${p?.target ?? p?.published}`;
        const [hostPart, containerPart] = portStr.split(':');
        const containerPort = parseInt(containerPart ?? hostPart, 10);
        const servicePort = parseInt(hostPart, 10);
        if (Number.isFinite(containerPort)) {
          ports.push({
            containerPort,
            servicePort: Number.isFinite(servicePort) ? servicePort : containerPort,
            protocol: 'TCP'
          });
        }
      }

      const env: ParsedComposeService['env'] = [];
      const envSrc = svc?.environment;
      if (Array.isArray(envSrc)) {
        for (const entry of envSrc) {
          const [k, ...rest] = String(entry).split('=');
          env.push({ key: k, value: rest.join('=') });
        }
      } else if (envSrc && typeof envSrc === 'object') {
        for (const [k, v] of Object.entries<any>(envSrc)) {
          env.push({ key: k, value: v == null ? '' : String(v) });
        }
      }

      const volumes: ParsedComposeService['volumes'] = [];
      for (const v of svc?.volumes ?? []) {
        const spec = typeof v === 'string' ? v : null;
        if (!spec) continue;
        const [src, dst] = spec.split(':');
        if (!src || !dst) continue;
        if (src.startsWith('/') || src.startsWith('.')) continue; // bind mount: skip
        const top = volumesTop[src];
        volumes.push({
          name: src,
          type: 'pvc',
          mountPath: dst,
          storageSize: top?.driver_opts?.size ?? '1Gi'
        });
      }

      out.push({
        name,
        image: svc?.image,
        build: svc?.build
          ? {
              context: typeof svc.build === 'string' ? svc.build : svc.build?.context,
              dockerfile: typeof svc.build === 'object' ? svc.build?.dockerfile : undefined
            }
          : undefined,
        ports,
        env,
        volumes,
        replicas: typeof svc?.deploy?.replicas === 'number' ? svc.deploy.replicas : 1,
        command: parseComposeCommand(svc?.command),
        ...this.parseComposeResources(svc)
      });
    }

    const volumeOwners = new Map<string, string>();
    for (const svc of out) {
      for (const volume of new Set(svc.volumes.map((v) => v.name))) {
        const owner = volumeOwners.get(volume);
        if (owner) {
          throw new BadRequestException(
            `Services "${owner}" and "${svc.name}" both use volume "${volume}". Two services can't share a volume, so give each one its own.`
          );
        }
        volumeOwners.set(volume, svc.name);
      }
    }
    return out;
  }

  private async fetchComposeFromGithub(
    userId: string,
    repoUrl: string,
    branch: string,
    composePath: string
  ): Promise<{ composeYaml: string; installationId: bigint | null }> {
    const parsed = this.github.parseRepoUrl(repoUrl);
    if (!parsed) throw new BadRequestException('Could not parse repository URL');

    const canAccess = await this.github.verifyUserCanAccessRepo(userId, parsed.owner, parsed.repo);
    if (!canAccess) {
      const isPublic = await this.github.isRepoPublic(parsed.owner, parsed.repo);
      if (!isPublic) {
        throw new ForbiddenException(
          'You do not have access to this repository on GitHub. Connect your GitHub account or request access to the repo.'
        );
      }
    }

    const token = await this.github.resolveRepoToken(userId, parsed.owner, parsed.repo);
    const composeYaml = await this.github.getFileContent(
      token ?? '',
      parsed.owner,
      parsed.repo,
      composePath,
      branch
    );

    // Best-effort: capture an installation id we can use for webhook matching.
    let installationId: bigint | null = null;
    try {
      const installations = await this.prisma.gitHubAppInstallation.findMany({
        where: { userId },
        select: { installationId: true }
      });
      // Heuristic: assume the user's first installation owns the repo. If we get
      // it wrong, webhooks still won't trigger; the user can repick.
      if (installations.length > 0) {
        installationId = installations[0].installationId;
      }
    } catch {
      /* ignore */
    }

    return { composeYaml, installationId };
  }

  async createFromGithub(
    projectId: string,
    body: CreateFromGithubBody,
    clerkId: string,
    userData?: UserData
  ) {
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(projectId, userId, 'create a compose stack');

    const name = this.formatStackName(String(body.name || '').trim());
    if (!name) throw new BadRequestException('Stack name is required');

    const repoUrl = String(body.repoUrl || '')
      .trim()
      .replace(/\.git$/, '');
    const branch = String(body.branch || 'main').trim();
    const composePath = String(body.composePath || 'docker-compose.yml').trim();
    const autoDeployEnabled = Boolean(body.autoDeployEnabled);

    if (!repoUrl) throw new BadRequestException('Repository URL is required');

    // Pin the stack to a concrete environment now so create + every later
    // redeploy drop the child deployments into the same namespace. Validates
    // the id belongs to this project (or resolves the project default).
    const environment = await this.environments.resolveEnvironment(projectId, body.environmentId);

    const existing = await this.prisma.composeStack.findUnique({
      where: { projectId_name: { projectId, name } }
    });
    if (existing) {
      throw new BadRequestException('A compose stack with this name already exists in the project');
    }

    const { composeYaml, installationId } = await this.fetchComposeFromGithub(
      userId,
      repoUrl,
      branch,
      composePath
    );

    const services = this.parseCompose(composeYaml);
    await this.deployments.assertEnvironmentVolumesUnclaimed(
      projectId,
      environment.id,
      services.flatMap((svc) => svc.volumes)
    );

    const stack = await this.prisma.composeStack.create({
      data: {
        projectId,
        environmentId: environment.id,
        name,
        composeYaml,
        status: 'deploying',
        githubRepo: repoUrl,
        githubBranch: branch,
        composePath,
        githubInstallationId: installationId,
        autoDeployEnabled,
        autoDeployBranch: autoDeployEnabled ? branch : null,
        buildStatus: services.some((s) => s.build) ? 'building' : 'none',
        createdBy: userId
      }
    });

    try {
      await this.deployChildren(stack.id, services, clerkId, userData);
      await this.prisma.composeStack.update({
        where: { id: stack.id },
        data: { status: 'active', lastError: null }
      });
      return this.getComposeStack(stack.id, clerkId, userData);
    } catch (e: any) {
      this.logger.error(`Compose stack ${stack.id} deploy failed: ${e.message}`);
      await this.prisma.composeStack
        .update({ where: { id: stack.id }, data: { status: 'failed', lastError: e.message } })
        .catch(() => undefined);
      try {
        await this.deleteChildDeployments(stack.id, clerkId, userData);
        await this.prisma.composeStack.delete({ where: { id: stack.id } });
      } catch (rb: any) {
        this.logger.error(`Rollback of failed compose stack ${stack.id} incomplete: ${rb.message}`);
      }
      throw new BadRequestException(`Compose stack deployment failed: ${e.message}`);
    }
  }

  private mergeComposeEnv(
    composeEnv: { key: string; value: string }[],
    preserved?: PreservedEnv[]
  ): PreservedEnv[] {
    const merged = new Map<string, PreservedEnv>();
    for (const e of preserved ?? []) merged.set(e.key, e);
    for (const e of composeEnv ?? []) {
      const kept = merged.get(e.key);
      merged.set(e.key, { ...e, secret: Boolean(kept?.secret) || looksSecret(e.key) });
    }
    return Array.from(merged.values());
  }

  private async deployChildren(
    stackId: string,
    services: ParsedComposeService[],
    clerkId: string,
    userData?: UserData,
    preservedEnv?: Map<string, PreservedEnv[]>
  ) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack disappeared');

    for (const svc of services) {
      const deployName = `${stack.name}-${svc.name}`.slice(0, 63);
      const env = this.mergeComposeEnv(svc.env, preservedEnv?.get(svc.name));
      if (svc.build) {
        // Reuse the existing GitHub-build pipeline. Each child deployment owns
        // its own buildStatus/buildLogs and webhooks fan out per child.
        const dockerfilePath = svc.build.dockerfile || 'Dockerfile';
        const buildFromRoot =
          !svc.build.context || svc.build.context === '.' || svc.build.context === './';
        await this.deployments.createDeploymentFromGitHub(
          stack.projectId,
          {
            name: deployName,
            repoUrl: stack.githubRepo!,
            branch: stack.githubBranch!,
            dockerfilePath,
            buildType: 'dockerfile',
            buildFromRoot,
            replicas: svc.replicas,
            ports: svc.ports.length > 0 ? svc.ports : undefined,
            env,
            volumes: svc.volumes.map((v) => ({
              name: v.name,
              type: v.type,
              mountPath: v.mountPath,
              pvcName: v.name,
              storageSize: v.storageSize
            })),
            cpuRequestMilli: svc.cpuRequestMilli ?? null,
            memoryRequestBytes: svc.memoryRequestBytes ?? null,
            startCommand: svc.command ?? null,
            composeStackId: stack.id,
            composeServiceName: svc.name,
            environmentId: stack.environmentId ?? undefined,
            autoDeployEnabled: stack.autoDeployEnabled,
            autoDeployBranch: stack.autoDeployBranch ?? stack.githubBranch ?? undefined
          },
          clerkId,
          userData
        );
      } else if (svc.image) {
        await this.deployments.createDeployment(
          stack.projectId,
          {
            name: deployName,
            image: svc.image,
            replicas: svc.replicas,
            ports: svc.ports.length > 0 ? svc.ports : undefined,
            env,
            volumes: svc.volumes.map((v) => ({
              name: v.name,
              type: v.type,
              mountPath: v.mountPath,
              pvcName: v.name,
              storageSize: v.storageSize
            })),
            cpuRequestMilli: svc.cpuRequestMilli ?? null,
            memoryRequestBytes: svc.memoryRequestBytes ?? null,
            startCommand: svc.command ?? null,
            composeStackId: stack.id,
            composeServiceName: svc.name,
            environmentId: stack.environmentId ?? undefined
          },
          clerkId,
          userData
        );
      }
    }
  }

  /**
   * Re-pull compose from GitHub and reconcile the child deployments against it.
   * A service that still exists keeps its deployment, so everything attached
   * to it survives: domains, volumes and their data, env edits, history. Only
   * services added to or removed from the file are created or deleted.
   */
  async redeployFromGithub(stackId: string, clerkId: string, userData?: UserData) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    if (!stack.githubRepo) {
      throw new BadRequestException('This stack is not linked to a GitHub source');
    }
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'redeploy a compose stack');

    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: { status: 'updating' }
    });

    const { composeYaml } = await this.fetchComposeFromGithub(
      userId,
      stack.githubRepo,
      stack.githubBranch ?? 'main',
      stack.composePath ?? 'docker-compose.yml'
    );

    let services: ParsedComposeService[];
    try {
      services = this.parseCompose(composeYaml);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: e.message }
      });
      throw e;
    }

    const children = await this.loadChildren(stackId);
    try {
      await this.deployments.assertEnvironmentVolumesUnclaimed(
        stack.projectId,
        stack.environmentId,
        services.flatMap((svc) => svc.volumes),
        children.map((child) => child.id)
      );
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: e.message }
      });
      throw e;
    }
    const wanted = new Map(services.map((svc) => [svc.name, svc]));
    const replaced = children.filter((child) => {
      const svc = child.composeServiceName ? wanted.get(child.composeServiceName) : undefined;
      return !svc || Boolean(svc.build) !== Boolean(child.githubRepo);
    });
    const kept = children.filter((child) => !replaced.includes(child));

    const preservedEnv = new Map<string, PreservedEnv[]>();
    for (const child of replaced) {
      if (child.composeServiceName) preservedEnv.set(child.composeServiceName, child.envVars);
    }

    try {
      await this.deleteChildDeployments(
        stackId,
        clerkId,
        userData,
        replaced.map((child) => child.id)
      );
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: `Teardown failed: ${e.message}` }
      });
      throw new BadRequestException(`Redeploy failed during teardown: ${e.message}`);
    }

    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: { composeYaml, status: 'deploying' }
    });

    try {
      for (const child of kept) {
        await this.reconcileChild(
          child,
          wanted.get(child.composeServiceName!)!,
          userId,
          clerkId,
          userData
        );
      }
      const existing = new Set(kept.map((child) => child.composeServiceName));
      await this.deployChildren(
        stackId,
        services.filter((svc) => !existing.has(svc.name)),
        clerkId,
        userData,
        preservedEnv
      );
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'active', lastError: null }
      });
      return this.getComposeStack(stackId, clerkId, userData);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: e.message }
      });
      throw new BadRequestException(`Compose stack redeploy failed: ${e.message}`);
    }
  }

  private loadChildren(stackId: string): Promise<ComposeChild[]> {
    return this.prisma.deployment.findMany({
      where: { composeStackId: stackId },
      select: CHILD_SELECT
    });
  }

  private async reconcileChild(
    child: ComposeChild,
    svc: ParsedComposeService,
    userId: string,
    clerkId: string,
    userData?: UserData
  ) {
    const asCompose = { fromComposeStack: true };

    const stored = new Map(child.envVars.map((e) => [e.key, e]));
    const envChanged = svc.env.some((e) => {
      const current = stored.get(e.key);
      return !current || current.secret || current.value !== e.value;
    });
    if (envChanged) {
      const composeKeys = new Set(svc.env.map((e) => e.key));
      await this.deployments.updateDeploymentEnvVars(
        child.id,
        [
          ...child.envVars
            .filter((e) => !composeKeys.has(e.key))
            .map((e) => ({ key: e.key, value: null, secret: e.secret })),
          ...svc.env.map((e) => ({
            key: e.key,
            value: e.value,
            secret: stored.get(e.key)?.secret
          }))
        ],
        clerkId,
        userData
      );
    }

    const mounted = new Set(child.volumes.map((v) => v.name));
    const addedVolumes = svc.volumes.filter((v) => !mounted.has(v.name));
    if (addedVolumes.length > 0) {
      await this.deployments.updateDeploymentVolumes(
        child.id,
        [
          ...child.volumes.map((v) => ({
            name: v.name,
            type: v.type as 'pvc' | 'hostPath' | 'emptyDir',
            mountPath: v.mountPath,
            pvcName: v.pvcName ?? undefined,
            storageSize: v.storageSize ?? undefined,
            hostPath: v.hostPath ?? undefined,
            readOnly: v.readOnly
          })),
          ...addedVolumes.map((v) => ({
            name: v.name,
            type: v.type,
            mountPath: v.mountPath,
            pvcName: v.name,
            storageSize: v.storageSize
          }))
        ],
        clerkId,
        userData,
        asCompose
      );
    }

    const cpu = svc.cpuRequestMilli ?? null;
    const memory = svc.memoryRequestBytes ?? null;
    const storedMemory = child.memoryRequestBytes != null ? Number(child.memoryRequestBytes) : null;
    if (cpu !== child.cpuRequestMilli || memory !== storedMemory) {
      await this.deployments.updateDeploymentResources(
        child.id,
        { cpuRequestMilli: cpu, memoryRequestBytes: memory },
        userId,
        asCompose
      );
    }

    if (!child.stopped && svc.replicas !== child.replicas) {
      await this.deployments.scaleDeployment(child.id, svc.replicas, clerkId, userData, asCompose);
    }

    const primary = child.services.find((s) => s.name === child.name) ?? child.services[0];
    if (primary && svc.ports.length > 0 && !this.samePorts(primary.ports, svc.ports)) {
      await this.deployments.updateServiceConfiguration(
        child.id,
        primary.id,
        { ports: svc.ports },
        clerkId,
        userData
      );
    }

    const buildConfig: {
      startCommand?: string | null;
      dockerfilePath?: string;
      buildFromRoot?: boolean;
    } = {};
    if ((svc.command ?? null) !== (child.startCommand ?? null)) {
      buildConfig.startCommand = svc.command ?? null;
    }
    if (svc.build) {
      const dockerfilePath = svc.build.dockerfile || 'Dockerfile';
      const buildFromRoot =
        !svc.build.context || svc.build.context === '.' || svc.build.context === './';
      if (dockerfilePath !== child.dockerfilePath) buildConfig.dockerfilePath = dockerfilePath;
      if (buildFromRoot !== child.buildFromRoot) buildConfig.buildFromRoot = buildFromRoot;
    }
    if (Object.keys(buildConfig).length > 0) {
      await this.deployments.updateDeploymentBuildConfig(child.id, buildConfig, clerkId, userData);
    }

    if (svc.build) {
      await this.deployments.rebuildDeployment(child.id, clerkId, userData);
    } else if (svc.image && svc.image !== child.image) {
      await this.deployments.updateDeploymentImage(child.id, svc.image, userId, asCompose);
    } else if (!child.stopped) {
      await this.deployments.restartDeployment(child.id, clerkId, userData);
    }
  }

  private samePorts(
    current: { port: number; targetPort: number; protocol: string }[],
    wanted: ParsedComposeService['ports']
  ) {
    const key = (p: { servicePort: number; containerPort: number; protocol: string }) =>
      `${p.servicePort}:${p.containerPort}/${p.protocol.toUpperCase()}`;
    const have = current
      .map((p) => key({ servicePort: p.port, containerPort: p.targetPort, protocol: p.protocol }))
      .sort();
    const want = wanted.map(key).sort();
    return have.length === want.length && have.every((k, i) => k === want[i]);
  }

  async setAutoDeploy(stackId: string, enabled: boolean, clerkId: string, userData?: UserData) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'update auto-deploy');

    const branch = stack.githubBranch;
    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: {
        autoDeployEnabled: enabled,
        autoDeployBranch: enabled ? branch : null
      }
    });

    // Mirror the toggle to every child deployment that came from GitHub. The
    // per-deployment webhook handler already keys on `autoDeployEnabled`.
    await this.prisma.deployment.updateMany({
      where: { composeStackId: stackId, githubRepo: { not: null } },
      data: {
        autoDeployEnabled: enabled,
        autoDeployBranch: enabled ? branch : null
      }
    });

    return this.getComposeStack(stackId, clerkId, userData);
  }

  async renameComposeStack(stackId: string, name: string, clerkId: string, userData?: UserData) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'rename a compose stack');

    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    if (trimmed !== stack.name) {
      const existing = await this.prisma.composeStack.findFirst({
        where: { projectId: stack.projectId, name: trimmed, id: { not: stackId } }
      });
      if (existing) {
        throw new BadRequestException(
          'A compose stack with this name already exists in this project'
        );
      }
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { name: trimmed }
      });
    }

    return this.getComposeStack(stackId, clerkId, userData);
  }

  async getComposeStack(stackId: string, clerkId: string, userData?: UserData) {
    const userId = await this.resolveUserId(clerkId, userData);
    const stack = await this.prisma.composeStack.findUnique({
      where: { id: stackId },
      include: {
        deployments: {
          select: {
            id: true,
            name: true,
            status: true,
            image: true,
            replicas: true,
            buildStatus: true,
            buildStep: true,
            composeServiceName: true,
            createdAt: true
          }
        }
      }
    });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const access = await this.authz.requireProjectView(stack.projectId, userId);
    return access.canEdit ? stack : scrubComposeStackForViewer(stack);
  }

  async listForProject(projectId: string, clerkId: string, userData?: UserData) {
    const userId = await this.resolveUserId(clerkId, userData);
    const access = await this.authz.requireProjectView(projectId, userId);
    const stacks = await this.prisma.composeStack.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        deployments: {
          select: { id: true, name: true, status: true, composeServiceName: true }
        }
      }
    });
    return access.canEdit ? stacks : stacks.map(scrubComposeStackForViewer);
  }

  async deleteComposeStack(stackId: string, clerkId: string, userData?: UserData) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'delete a compose stack');

    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: { status: 'deleting' }
    });

    try {
      await this.deleteChildDeployments(stackId, clerkId, userData);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: `Delete failed: ${e.message}` }
      });
      throw new BadRequestException(`Compose stack delete failed: ${e.message}`);
    }

    await this.prisma.composeStack.delete({ where: { id: stackId } });
    return { success: true };
  }

  private async deleteChildDeployments(
    stackId: string,
    clerkId: string,
    userData?: UserData,
    onlyIds?: string[]
  ) {
    const deployments = await this.prisma.deployment.findMany({
      where: { composeStackId: stackId, ...(onlyIds && { id: { in: onlyIds } }) },
      select: { id: true }
    });
    const errors: string[] = [];
    for (const d of deployments) {
      try {
        await this.deployments.deleteDeployment(d.id, clerkId, userData, {
          fromComposeStack: true
        });
      } catch (e: any) {
        errors.push(`deployment ${d.id}: ${e.message}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }
}
