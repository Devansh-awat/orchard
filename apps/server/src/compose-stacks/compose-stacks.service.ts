import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as yaml from 'js-yaml';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { DeploymentsService } from '../projects/deployments.service';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';
import { GitHubService } from '../github/github.service';

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
}

interface ParsedComposeService {
  name: string;
  image?: string;
  build?: { context?: string; dockerfile?: string };
  ports: { containerPort: number; servicePort: number; protocol: string }[];
  env: { key: string; value: string }[];
  volumes: { name: string; type: 'pvc' | 'emptyDir'; mountPath: string; storageSize?: string }[];
  replicas: number;
}

@Injectable()
export class ComposeStacksService {
  private readonly logger = new Logger(ComposeStacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly deployments: DeploymentsService,
    private readonly authz: AuthorizationService,
    private readonly usersService: UsersService,
    private readonly github: GitHubService,
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
        throw new BadRequestException(`Service "${name}" must have either \`image:\` or \`build:\``);
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
            protocol: 'TCP',
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
        if (src.startsWith('/') || src.startsWith('.')) continue; // bind mount — skip
        const top = volumesTop[src];
        volumes.push({
          name: src,
          type: 'pvc',
          mountPath: dst,
          storageSize: top?.driver_opts?.size ?? '1Gi',
        });
      }

      out.push({
        name,
        image: svc?.image,
        build: svc?.build
          ? {
              context: typeof svc.build === 'string' ? svc.build : svc.build?.context,
              dockerfile: typeof svc.build === 'object' ? svc.build?.dockerfile : undefined,
            }
          : undefined,
        ports,
        env,
        volumes,
        replicas: typeof svc?.deploy?.replicas === 'number' ? svc.deploy.replicas : 1,
      });
    }
    return out;
  }

  private async fetchComposeFromGithub(
    userId: string,
    repoUrl: string,
    branch: string,
    composePath: string,
  ): Promise<{ composeYaml: string; installationId: bigint | null }> {
    const parsed = this.github.parseRepoUrl(repoUrl);
    if (!parsed) throw new BadRequestException('Could not parse repository URL');
    const token = await this.github.resolveRepoToken(userId, parsed.owner, parsed.repo);
    if (!token) {
      throw new BadRequestException(
        'No GitHub access for this repo. Connect your GitHub account or install the GitHub App.',
      );
    }
    const composeYaml = await this.github.getFileContent(token, parsed.owner, parsed.repo, composePath, branch);

    // Best-effort: capture an installation id we can use for webhook matching.
    let installationId: bigint | null = null;
    try {
      const installations = await this.prisma.gitHubAppInstallation.findMany({
        where: { userId },
        select: { installationId: true },
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
    userData?: UserData,
  ) {
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(projectId, userId, 'create a compose stack');

    const name = this.formatStackName(String(body.name || '').trim());
    if (!name) throw new BadRequestException('Stack name is required');

    const repoUrl = String(body.repoUrl || '').trim().replace(/\.git$/, '');
    const branch = String(body.branch || 'main').trim();
    const composePath = String(body.composePath || 'docker-compose.yml').trim();
    const autoDeployEnabled = Boolean(body.autoDeployEnabled);

    if (!repoUrl) throw new BadRequestException('Repository URL is required');

    const existing = await this.prisma.composeStack.findUnique({
      where: { projectId_name: { projectId, name } },
    });
    if (existing) {
      throw new BadRequestException('A compose stack with this name already exists in the project');
    }

    const { composeYaml, installationId } = await this.fetchComposeFromGithub(
      userId,
      repoUrl,
      branch,
      composePath,
    );

    const services = this.parseCompose(composeYaml);

    const stack = await this.prisma.composeStack.create({
      data: {
        projectId,
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
        createdBy: userId,
      },
    });

    try {
      await this.deployChildren(stack.id, services, clerkId, userData);
      await this.prisma.composeStack.update({
        where: { id: stack.id },
        data: { status: 'active', lastError: null },
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
    preserved?: { key: string; value: string }[],
  ): { key: string; value: string }[] {
    const merged = new Map<string, string>();
    for (const e of preserved ?? []) merged.set(e.key, e.value);
    for (const e of composeEnv ?? []) merged.set(e.key, e.value);
    return Array.from(merged.entries()).map(([key, value]) => ({ key, value }));
  }

  private async deployChildren(
    stackId: string,
    services: ParsedComposeService[],
    clerkId: string,
    userData?: UserData,
    preservedEnv?: Map<string, { key: string; value: string }[]>,
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
              storageSize: v.storageSize,
            })),
            composeStackId: stack.id,
            composeServiceName: svc.name,
            autoDeployEnabled: stack.autoDeployEnabled,
            autoDeployBranch: stack.autoDeployBranch ?? stack.githubBranch ?? undefined,
          },
          clerkId,
          userData,
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
              storageSize: v.storageSize,
            })),
            composeStackId: stack.id,
            composeServiceName: svc.name,
          },
          clerkId,
          userData,
        );
      }
    }
  }

  /**
   * Re-pull compose from GitHub and recreate all child deployments. The
   * existing per-deployment auto-deploy webhook handler will continue to
   * rebuild individual services when commits land on the tracked branch; this
   * method is for cases where the *compose file itself* changed (new services
   * added, services removed, ports/env changed).
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
      data: { status: 'updating' },
    });

    const { composeYaml } = await this.fetchComposeFromGithub(
      userId,
      stack.githubRepo,
      stack.githubBranch ?? 'main',
      stack.composePath ?? 'docker-compose.yml',
    );

    let services: ParsedComposeService[];
    try {
      services = this.parseCompose(composeYaml);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: e.message },
      });
      throw e;
    }

    const existingChildren = await this.prisma.deployment.findMany({
      where: { composeStackId: stackId },
      select: {
        composeServiceName: true,
        envVars: { select: { key: true, value: true } },
      },
    });
    const preservedEnv = new Map<string, { key: string; value: string }[]>();
    for (const child of existingChildren) {
      if (child.composeServiceName) preservedEnv.set(child.composeServiceName, child.envVars);
    }

    try {
      await this.deleteChildDeployments(stackId, clerkId, userData);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: `Teardown failed: ${e.message}` },
      });
      throw new BadRequestException(`Redeploy failed during teardown: ${e.message}`);
    }

    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: { composeYaml, status: 'deploying' },
    });

    try {
      await this.deployChildren(stackId, services, clerkId, userData, preservedEnv);
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'active', lastError: null },
      });
      return this.getComposeStack(stackId, clerkId, userData);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: e.message },
      });
      throw new BadRequestException(`Compose stack redeploy failed: ${e.message}`);
    }
  }

  async setAutoDeploy(
    stackId: string,
    enabled: boolean,
    clerkId: string,
    userData?: UserData,
  ) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'update auto-deploy');

    const branch = stack.githubBranch;
    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: {
        autoDeployEnabled: enabled,
        autoDeployBranch: enabled ? branch : null,
      },
    });

    // Mirror the toggle to every child deployment that came from GitHub. The
    // per-deployment webhook handler already keys on `autoDeployEnabled`.
    await this.prisma.deployment.updateMany({
      where: { composeStackId: stackId, githubRepo: { not: null } },
      data: {
        autoDeployEnabled: enabled,
        autoDeployBranch: enabled ? branch : null,
      },
    });

    return this.getComposeStack(stackId, clerkId, userData);
  }

  async renameComposeStack(
    stackId: string,
    name: string,
    clerkId: string,
    userData?: UserData,
  ) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'rename a compose stack');

    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    if (trimmed !== stack.name) {
      const existing = await this.prisma.composeStack.findFirst({
        where: { projectId: stack.projectId, name: trimmed, id: { not: stackId } },
      });
      if (existing) {
        throw new BadRequestException('A compose stack with this name already exists in this project');
      }
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { name: trimmed },
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
            createdAt: true,
          },
        },
      },
    });
    if (!stack) throw new NotFoundException('Compose stack not found');
    await this.authz.requireProjectView(stack.projectId, userId);
    return stack;
  }

  async listForProject(projectId: string, clerkId: string, userData?: UserData) {
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectView(projectId, userId);
    return this.prisma.composeStack.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        deployments: {
          select: { id: true, name: true, status: true, composeServiceName: true },
        },
      },
    });
  }

  async deleteComposeStack(stackId: string, clerkId: string, userData?: UserData) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'delete a compose stack');

    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: { status: 'deleting' },
    });

    try {
      await this.deleteChildDeployments(stackId, clerkId, userData);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: `Delete failed: ${e.message}` },
      });
      throw new BadRequestException(`Compose stack delete failed: ${e.message}`);
    }

    await this.prisma.composeStack.delete({ where: { id: stackId } });
    return { success: true };
  }

  private async deleteChildDeployments(stackId: string, clerkId: string, userData?: UserData) {
    const deployments = await this.prisma.deployment.findMany({
      where: { composeStackId: stackId },
      select: { id: true },
    });
    const errors: string[] = [];
    for (const d of deployments) {
      try {
        await this.deployments.deleteDeployment(d.id, clerkId, userData, { fromComposeStack: true });
      } catch (e: any) {
        errors.push(`deployment ${d.id}: ${e.message}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }
}
