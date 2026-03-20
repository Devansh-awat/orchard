import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
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
  ) {}

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

  async createTemplate(yamlContent: string) {
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

  async updateTemplate(id: string, yamlContent: string) {
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

  async deleteTemplate(id: string) {
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
  ) {
    const template = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw new NotFoundException('Template not found');

    const parsed = this.templateEngine.parseTemplate(template.yaml);
    const validatedParams = this.templateEngine.validateParameters(parameters, parsed.parameters);

    // Resolve user
    const user = await this.prisma.user.findFirst({
      where: { hackClubId: clerkId },
    });

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
              { name: config.name },
              clerkId,
              userData,
            );

            // Link to template instance
            await this.prisma.database.update({
              where: { id: db.id },
              data: { templateInstanceId: instance.id },
            });

            // Store in context for cross-references
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
            };

            const deployment = await this.projectsService.createDeployment(
              projectId,
              deployData,
              clerkId,
              userData,
            );

            // Link to template instance
            await this.prisma.deployment.update({
              where: { id: deployment.id },
              data: { templateInstanceId: instance.id },
            });

            // Get the service name for cross-references
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

            // Get ingresses before creation to diff afterwards
            const ingressesBefore = await this.prisma.ingress.findMany({
              where: { projectId },
              select: { id: true },
            });
            const beforeIds = new Set(ingressesBefore.map((i) => i.id));

            await this.projectsService.createProjectIngress(
              projectId,
              {
                host: config.host,
                tlsEnabled: config.tlsEnabled !== false,
                routes,
                basicAuth: config.basicAuth,
              },
              clerkId,
              userData,
            );

            // Find newly created ingresses by diffing
            const ingressesAfter = await this.prisma.ingress.findMany({
              where: { projectId },
              select: { id: true, host: true },
            });
            const newIngresses = ingressesAfter.filter((i) => !beforeIds.has(i.id));

            // Link new ingresses to template instance
            for (const ing of newIngresses) {
              await this.prisma.ingress.update({
                where: { id: ing.id },
                data: { templateInstanceId: instance.id },
              });
            }

            context.resources[resource.name] = {
              id: newIngresses[0]?.id,
              host: config.host,
            };
            break;
          }
        }
      }

      // Mark as active
      await this.prisma.templateInstance.update({
        where: { id: instance.id },
        data: { status: 'active' },
      });

      return this.getTemplateInstance(instance.id);
    } catch (e) {
      // Mark as failed but keep created resources
      await this.prisma.templateInstance.update({
        where: { id: instance.id },
        data: { status: 'failed' },
      });

      throw new BadRequestException(
        `Template deployment failed: ${e.message}`,
      );
    }
  }

  async getTemplateInstance(instanceId: string) {
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

  async getProjectTemplateInstances(projectId: string) {
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

    // Delete the instance record
    await this.prisma.templateInstance.delete({ where: { id: instanceId } });

    if (errors.length > 0) {
      this.logger.warn(`Template instance ${instanceId} deleted with errors: ${errors.join('; ')}`);
    }

    return { success: true, errors };
  }
}
