import { Controller, Get, Post, Put, Delete, Param, Body, Request } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { Auth } from '../auth/decorators';

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

  @Post('templates')
  async createTemplate(
    @Body() body: { yaml: string },
  ) {
    return this.templatesService.createTemplate(body.yaml);
  }

  @Put('templates/:id')
  async updateTemplate(
    @Param('id') id: string,
    @Body() body: { yaml: string },
  ) {
    return this.templatesService.updateTemplate(id, body.yaml);
  }

  @Delete('templates/:id')
  async deleteTemplate(@Param('id') id: string) {
    return this.templatesService.deleteTemplate(id);
  }

  @Post('projects/:projectId/template-instances')
  async deployTemplate(
    @Param('projectId') projectId: string,
    @Body() body: { templateId: string; parameters: Record<string, any> },
    @Request() req,
  ) {
    return this.templatesService.deployTemplate(
      projectId,
      body.templateId,
      body.parameters,
      req.user.hackClubId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName || req.user.name?.split(' ')[0],
        lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
        imageUrl: req.user.imageUrl,
      },
    );
  }

  @Get('projects/:projectId/template-instances')
  async getProjectTemplateInstances(@Param('projectId') projectId: string) {
    return this.templatesService.getProjectTemplateInstances(projectId);
  }

  @Get('template-instances/:id')
  async getTemplateInstance(@Param('id') id: string) {
    return this.templatesService.getTemplateInstance(id);
  }

  @Delete('template-instances/:id')
  async deleteTemplateInstance(@Param('id') id: string, @Request() req) {
    return this.templatesService.deleteTemplateInstance(
      id,
      req.user.hackClubId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl,
      },
    );
  }
}
