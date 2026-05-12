import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';
import {
  TemplateEngineService,
  ResolutionContext,
  ParsedTemplate,
} from './template-engine.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class TemplatesService implements OnModuleInit {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly templateEngine: TemplateEngineService,
    private readonly authz: AuthorizationService,
    private readonly usersService: UsersService,
  ) {}

  private async resolveUserId(clerkId: string, userData?: any): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    return user.id;
  }

  private async requireSuperAdmin(clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true },
    });
    if (!u?.isSuperAdmin) {
      throw new ForbiddenException('Only superadmins can manage global templates');
    }
    return userId;
  }

  async onModuleInit() {
    this.logger.log('onModuleInit: starting seedBuiltInTemplates...');
    await this.seedBuiltInTemplates();
    this.logger.log('onModuleInit: seedBuiltInTemplates complete');
  }

  private async seedBuiltInTemplates() {
    const builtInDir = path.join(__dirname, 'built-in');
    this.logger.log(`Looking for built-in templates in: ${builtInDir}`);
    if (!fs.existsSync(builtInDir)) {
      this.logger.warn(`Built-in templates directory not found: ${builtInDir}`);
      return;
    }

    const files = fs.readdirSync(builtInDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    this.logger.log(`Found ${files.length} template files: ${files.join(', ')}`);

    for (const file of files) {
      try {
        this.logger.log(`Processing template file: ${file}`);
        const yamlContent = fs.readFileSync(path.join(builtInDir, file), 'utf-8');
        const parsed = this.templateEngine.parseTemplate(yamlContent);
        this.logger.log(`Parsed template: ${parsed.metadata.name}, upserting to DB...`);

        await this.prisma.template.upsert({
          where: { name: parsed.metadata.name },
          update: {
            displayName: parsed.metadata.displayName,
            description: parsed.metadata.description,
            icon: parsed.metadata.icon,
            version: parsed.metadata.version,
            category: parsed.metadata.category,
            tags: parsed.metadata.tags || [],
            yaml: yamlContent,
            isBuiltIn: true,
          },
          create: {
            name: parsed.metadata.name,
            displayName: parsed.metadata.displayName,
            description: parsed.metadata.description,
            icon: parsed.metadata.icon,
            version: parsed.metadata.version,
            category: parsed.metadata.category,
            tags: parsed.metadata.tags || [],
            yaml: yamlContent,
            isBuiltIn: true,
          },
        });

        this.logger.log(`Seeded built-in template: ${parsed.metadata.name}`);
      } catch (e) {
        this.logger.error(`Failed to seed template ${file}: ${e.message}`);
      }
    }
  }

  async listTemplates() {
    return this.prisma.template.findMany({
      orderBy: [{ isBuiltIn: 'desc' }, { displayName: 'asc' }],
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        icon: true,
        version: true,
        category: true,
        tags: true,
        isBuiltIn: true,
      },
    });
  }

  async getTemplate(id: string) {
    const template = await this.prisma.template.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');

    const parsed = this.templateEngine.parseTemplate(template.yaml);

    return {
      ...template,
      parameters: parsed.parameters,
      resources: parsed.resources.map((r) => ({
        name: r.name,
        type: r.type,
      })),
    };
  }

  async createTemplate(yamlContent: string, clerkId: string, userData?: any) {
    await this.requireSuperAdmin(clerkId, userData);
    const parsed = this.templateEngine.parseTemplate(yamlContent);

    // Check for name conflicts
    const existing = await this.prisma.template.findUnique({
      where: { name: parsed.metadata.name },
    });
    if (existing) {
      throw new BadRequestException(`A template with name "${parsed.metadata.name}" already exists`);
    }

    const template = await this.prisma.template.create({
      data: {
        name: parsed.metadata.name,
        displayName: parsed.metadata.displayName,
        description: parsed.metadata.description,
        icon: parsed.metadata.icon,
        version: parsed.metadata.version,
        category: parsed.metadata.category,
        tags: parsed.metadata.tags || [],
        yaml: yamlContent,
        isBuiltIn: false,
      },
    });

    return {
      ...template,
      parameters: parsed.parameters,
      resources: parsed.resources.map((r) => ({ name: r.name, type: r.type })),
    };
  }

  async updateTemplate(id: string, yamlContent: string, clerkId: string, userData?: any) {
    await this.requireSuperAdmin(clerkId, userData);
    const existing = await this.prisma.template.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');
    if (existing.isBuiltIn) {
      throw new BadRequestException('Built-in templates cannot be modified');
    }

    const parsed = this.templateEngine.parseTemplate(yamlContent);

    // Check name conflicts with other templates
    const nameConflict = await this.prisma.template.findFirst({
      where: { name: parsed.metadata.name, id: { not: id } },
    });
    if (nameConflict) {
      throw new BadRequestException(`A template with name "${parsed.metadata.name}" already exists`);
    }

    const template = await this.prisma.template.update({
      where: { id },
      data: {
        name: parsed.metadata.name,
        displayName: parsed.metadata.displayName,
        description: parsed.metadata.description,
        icon: parsed.metadata.icon,
        version: parsed.metadata.version,
        category: parsed.metadata.category,
        tags: parsed.metadata.tags || [],
        yaml: yamlContent,
      },
    });

    return {
      ...template,
      parameters: parsed.parameters,
      resources: parsed.resources.map((r) => ({ name: r.name, type: r.type })),
    };
  }

  async deleteTemplate(id: string, clerkId: string, userData?: any) {
    await this.requireSuperAdmin(clerkId, userData);
    const existing = await this.prisma.template.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');
    if (existing.isBuiltIn) {
      throw new BadRequestException('Built-in templates cannot be deleted');
    }

    // Check for active instances
    const instances = await this.prisma.templateInstance.count({
      where: { templateId: id },
    });
    if (instances > 0) {
      throw new BadRequestException(
        `Cannot delete template with ${instances} active instance(s). Delete instances first.`,
      );
    }

    await this.prisma.template.delete({ where: { id } });
    return { success: true };
  }

  async deployTemplate(
    projectId: string,
    templateId: string,
    parameters: Record<string, any>,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    resourceOverride?: {
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
    },
  ) {
    const template = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw new NotFoundException('Template not found');

    // Resolve user up front so we can authorise the project edit before doing
    // any work; the per-resource calls below also re-check, but failing fast
    // gives a clean 403 instead of a half-created TemplateInstance row.
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    await this.authz.requireProjectEdit(projectId, user.id, 'deploy a template');

    const parsed = this.templateEngine.parseTemplate(template.yaml);
    const validatedParams = this.templateEngine.validateParameters(parameters, parsed.parameters);

    // Create instance record
    const instance = await this.prisma.templateInstance.create({
      data: {
        templateId,
        projectId,
        name: validatedParams.appName || parsed.metadata.displayName,
        parameters: validatedParams,
        status: 'deploying',
        createdBy: user?.id,
      },
    });

    const context: ResolutionContext = {
      params: validatedParams,
      resources: {},
    };

    try {
      for (const resource of parsed.resources) {
        const config = this.templateEngine.resolveResourceConfig(resource, context);

        switch (resource.type) {
          case 'database': {
            const db = await this.projectsService.createDatabase(
              projectId,
              {
                name: config.name,
                templateInstanceId: instance.id,
                cpuRequestMilli: resourceOverride?.cpuRequestMilli ?? null,
                memoryRequestBytes: resourceOverride?.memoryRequestBytes ?? null,
              },
              clerkId,
              userData,
            );

            context.resources[resource.name] = {
              id: db.id,
              host: db.host,
              port: db.port,
              dbName: db.dbName,
              dbUser: db.dbUser,
              dbPassword: db.dbPassword,
              connectionString: `postgresql://${db.dbUser}:${db.dbPassword}@${db.host}:${db.port}/${db.dbName}`,
            };
            break;
          }

          case 'deployment': {
            const deployData: any = {
              name: config.name,
              image: config.image,
              replicas: config.replicas ? Number(config.replicas) : 1,
              ports: config.ports,
              env: config.env,
              volumes: config.volumes,
              exposePublic: config.exposePublic ?? false,
              templateInstanceId: instance.id,
              cpuRequestMilli: resourceOverride?.cpuRequestMilli ?? null,
              memoryRequestBytes: resourceOverride?.memoryRequestBytes ?? null,
            };

            const deployment = await this.projectsService.createDeployment(
              projectId,
              deployData,
              clerkId,
              userData,
            );

            const services = await this.prisma.service.findMany({
              where: { deploymentId: deployment.id },
            });

            context.resources[resource.name] = {
              id: deployment.id,
              serviceName: services[0]?.name || `${config.name}-svc`,
            };
            break;
          }

          case 'ingress': {
            const routes = config.routes || [
              {
                path: config.path || '/',
                serviceName: config.serviceName,
                servicePort: config.servicePort || 80,
              },
            ];

            await this.projectsService.createProjectIngress(
              projectId,
              {
                host: config.host,
                tlsEnabled: config.tlsEnabled !== false,
                routes,
                basicAuth: config.basicAuth,
                templateInstanceId: instance.id,
              },
              clerkId,
              userData,
            );

            const linkedIngress = await this.prisma.ingress.findFirst({
              where: { projectId, templateInstanceId: instance.id, host: config.host },
              select: { id: true },
            });

            context.resources[resource.name] = {
              id: linkedIngress?.id,
              host: config.host,
            };
            break;
          }
        }
      }

      await this.prisma.templateInstance.update({
        where: { id: instance.id },
        data: { status: 'active' },
      });

      return this.getTemplateInstance(instance.id);
    } catch (e) {
      await this.prisma.templateInstance.update({
        where: { id: instance.id },
        data: { status: 'failed' },
      }).catch(() => { /* ignore */ });

      try {
        await this.deleteTemplateInstance(instance.id, clerkId, userData);
      } catch (rollbackErr: any) {
        this.logger.error(
          `Rollback of failed template instance ${instance.id} incomplete: ${rollbackErr?.message}`,
        );
      }

      throw new BadRequestException(
        `Template deployment failed: ${e.message}`,
      );
    }
  }

  async getTemplateInstance(instanceId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const owner = await this.prisma.templateInstance.findUnique({
      where: { id: instanceId },
      select: { projectId: true },
    });
    if (!owner) throw new NotFoundException('Template instance not found');
    await this.authz.requireProjectView(owner.projectId, userId);
    const instance = await this.prisma.templateInstance.findUnique({
      where: { id: instanceId },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            displayName: true,
            icon: true,
            category: true,
          },
        },
        deployments: {
          select: {
            id: true,
            name: true,
            status: true,
            image: true,
          },
        },
        databases: {
          select: {
            id: true,
            name: true,
            status: true,
            dbName: true,
          },
        },
        ingresses: {
          select: {
            id: true,
            name: true,
            host: true,
            path: true,
          },
        },
      },
    });

    if (!instance) throw new NotFoundException('Template instance not found');
    return instance;
  }

  async getProjectTemplateInstances(projectId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectView(projectId, userId);
    return this.prisma.templateInstance.findMany({
      where: { projectId },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            displayName: true,
            icon: true,
            category: true,
          },
        },
        deployments: { select: { id: true } },
        databases: { select: { id: true } },
        ingresses: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteTemplateInstance(
    instanceId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
  ) {
    const instance = await this.prisma.templateInstance.findUnique({
      where: { id: instanceId },
      include: {
        deployments: { select: { id: true } },
        databases: { select: { id: true } },
        ingresses: { select: { id: true, projectId: true } },
      },
    });

    if (!instance) throw new NotFoundException('Template instance not found');

    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(instance.projectId, userId, 'delete a template instance');

    await this.prisma.templateInstance.update({
      where: { id: instanceId },
      data: { status: 'deleting' },
    });

    const errors: string[] = [];

    // Delete ingresses first
    for (const ingress of instance.ingresses) {
      try {
        await this.projectsService.deleteProjectIngress(
          ingress.projectId,
          ingress.id,
          clerkId,
          userData,
        );
      } catch (e) {
        errors.push(`Failed to delete ingress ${ingress.id}: ${e.message}`);
      }
    }

    // Delete deployments
    for (const deployment of instance.deployments) {
      try {
        await this.projectsService.deleteDeployment(
          deployment.id,
          clerkId,
          userData,
        );
      } catch (e) {
        errors.push(`Failed to delete deployment ${deployment.id}: ${e.message}`);
      }
    }

    // Delete databases
    for (const database of instance.databases) {
      try {
        await this.projectsService.deleteDatabase(
          database.id,
          clerkId,
          userData,
        );
      } catch (e) {
        errors.push(`Failed to delete database ${database.id}: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      this.logger.warn(`Template instance ${instanceId} cleanup had errors: ${errors.join('; ')}`);
      await this.prisma.templateInstance.update({
        where: { id: instanceId },
        data: { status: 'failed' },
      });
      throw new BadRequestException(
        `Template instance cleanup failed: ${errors.join('; ')}`,
      );
    }

    await this.prisma.templateInstance.delete({ where: { id: instanceId } });

    return { success: true, errors };
  }
}
