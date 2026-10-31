import { Controller, Get, Post } from '@nestjs/common';
import { DatabasePluginMigrationService } from './database-plugin-migration.service';

@Controller('admin/databases')
export class DatabaseAdminController {
  constructor(private readonly migration: DatabasePluginMigrationService) {}

  @Get('plugin-migration')
  status() {
    return this.migration.status();
  }

  @Post('plugin-migration/resume')
  resume() {
    return this.migration.resume();
  }
}
