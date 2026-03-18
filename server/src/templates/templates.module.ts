import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';
import { TemplateEngineService } from './template-engine.service';

@Module({
  imports: [ProjectsModule],
  providers: [TemplatesService, TemplateEngineService],
  controllers: [TemplatesController],
  exports: [TemplatesService],
})
export class TemplatesModule {}
