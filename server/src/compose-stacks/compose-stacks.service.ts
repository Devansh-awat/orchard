import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';
import { convertCompose, validateCompose } from './compose-converter';

interface UserData {
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
}

@Injectable()
export class ComposeStacksService {
  private readonly logger = new Logger(ComposeStacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly authz: AuthorizationService,
    private readonly usersService: UsersService,
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

  async createComposeStack(
    projectId: string,
    body: { name: string; composeYaml: string },
    clerkId: string,
    userData?: UserData,
  ) {
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(projectId, userId, 'create a compose stack');

    const name = this.formatStackName(String(body.name || '').trim());
    if (!name) throw new BadRequestException('Stack name is required');

    const composeYaml = String(body.composeYaml || '');
    try {
      validateCompose(composeYaml);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }

    const existing = await this.prisma.composeStack.findUnique({
      where: { projectId_name: { projectId, name } },
    });
    if (existing) {
      throw new BadRequestException('A compose stack with this name already exists in the project');
    }

    const stack = await this.prisma.composeStack.create({
      data: {
        projectId,
        name,
        composeYaml,
        status: 'deploying',
        createdBy: userId,
      },
    });

    try {
      const services = await convertCompose(composeYaml);
      for (const svc of services) {
        const deployName = `${name}-${svc.name}`.slice(0, 63);
        await this.projectsService.createDeployment(
          projectId,
          {
            name: deployName,
            image: svc.image,
            replicas: svc.replicas,
            ports: svc.ports,
            env: svc.env,
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

  async updateComposeStack(
    stackId: string,
    body: { composeYaml: string },
    clerkId: string,
    userData?: UserData,
  ) {
    const stack = await this.prisma.composeStack.findUnique({ where: { id: stackId } });
    if (!stack) throw new NotFoundException('Compose stack not found');
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(stack.projectId, userId, 'update a compose stack');

    const newYaml = String(body.composeYaml || '');
    try {
      validateCompose(newYaml);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }

    // Strategy: tear down existing deployments, then redeploy from new YAML.
    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: { status: 'updating' },
    });

    try {
      await this.deleteChildDeployments(stackId, clerkId, userData);
    } catch (e: any) {
      await this.prisma.composeStack.update({
        where: { id: stackId },
        data: { status: 'failed', lastError: `Teardown failed: ${e.message}` },
      });
      throw new BadRequestException(`Update failed during teardown: ${e.message}`);
    }

    await this.prisma.composeStack.update({
      where: { id: stackId },
      data: { composeYaml: newYaml, status: 'deploying' },
    });

    try {
      const services = await convertCompose(newYaml);
      for (const svc of services) {
        const deployName = `${stack.name}-${svc.name}`.slice(0, 63);
        await this.projectsService.createDeployment(
          stack.projectId,
          {
            name: deployName,
            image: svc.image,
            replicas: svc.replicas,
            ports: svc.ports,
            env: svc.env,
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
      throw new BadRequestException(`Compose stack update failed: ${e.message}`);
    }
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
        await this.projectsService.deleteDeployment(d.id, clerkId, userData, { fromComposeStack: true });
      } catch (e: any) {
        errors.push(`deployment ${d.id}: ${e.message}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }
}
