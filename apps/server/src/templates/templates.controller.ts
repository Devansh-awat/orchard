import { Controller, Get, Post, Put, Patch, Delete, Param, Body, Request } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { Auth, SuperAdmin } from '../auth/decorators';

@Auth()
@Controller()
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get('templates')
  async listTemplates() {
    return this.templatesService.listTemplates();
  }

  @Get('templates/:id')
  async getTemplate(@Param('id') id: string) {
    return this.templatesService.getTemplate(id);
  }

  @SuperAdmin()
  @Post('templates')
  async createTemplate(@Body() body: { yaml: string }, @Request() req) {
    return this.templatesService.createTemplate(body.yaml, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @SuperAdmin()
  @Put('templates/:id')
  async updateTemplate(@Param('id') id: string, @Body() body: { yaml: string }, @Request() req) {
    return this.templatesService.updateTemplate(id, body.yaml, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @SuperAdmin()
  @Delete('templates/:id')
  async deleteTemplate(@Param('id') id: string, @Request() req) {
    return this.templatesService.deleteTemplate(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post('projects/:projectId/template-instances')
  async deployTemplate(
    @Param('projectId') projectId: string,
    @Body() body: {
      templateId: string;
      parameters: Record<string, any>;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      resourceOverrides?: Record<
        string,
        { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null }
      >;
    },
    @Request() req
  ) {
    return this.templatesService.deployTemplate(
      projectId,
      body.templateId,
      body.parameters ?? {},
      req.user.externalAuthId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName || req.user.name?.split(' ')[0],
        lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
        imageUrl: req.user.imageUrl
      },
      {
        cpuRequestMilli: body.cpuRequestMilli ?? null,
        memoryRequestBytes: body.memoryRequestBytes ?? null
      },
      body.resourceOverrides
    );
  }

  @Get('projects/:projectId/template-instances')
  async getProjectTemplateInstances(@Param('projectId') projectId: string, @Request() req) {
    return this.templatesService.getProjectTemplateInstances(projectId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get('template-instances/:id')
  async getTemplateInstance(@Param('id') id: string, @Request() req) {
    return this.templatesService.getTemplateInstance(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch('template-instances/:id/name')
  async renameTemplateInstance(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @Request() req
  ) {
    return this.templatesService.renameTemplateInstance(id, body?.name ?? '', req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete('template-instances/:id')
  async deleteTemplateInstance(@Param('id') id: string, @Request() req) {
    return this.templatesService.deleteTemplateInstance(
      id,
      req.user.externalAuthId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }
}
