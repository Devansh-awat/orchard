import { BadRequestException, Body, Controller, Get, Patch } from '@nestjs/common';
import {
  DATABASE_TOGGLES,
  InstanceSettingsService,
  type DatabaseToggle
} from './instance-settings.service';

// Superadmin-only (default-deny: no @Auth()/@SuperAdmin() decorator, so the
// global SuperAdminGuard requires a superadmin).
@Controller('admin/instance-settings')
export class InstanceSettingsController {
  constructor(private readonly settings: InstanceSettingsService) {}

  @Get('userspace-scheduling')
  async getUserspaceScheduling() {
    return this.settings.getUserspaceSchedulingState();
  }

  @Patch('userspace-scheduling')
  async setUserspaceScheduling(@Body() body: { enabled?: boolean }) {
    await this.settings.setUserspaceScheduling(Boolean(body?.enabled));
    return this.settings.getUserspaceSchedulingState();
  }

  @Get('mcp')
  async getMcp() {
    return this.settings.getMcpState();
  }

  @Patch('mcp')
  async setMcp(@Body() body: { enabled?: boolean }) {
    await this.settings.setMcp(Boolean(body?.enabled));
    return this.settings.getMcpState();
  }

  @Get('databases')
  async getDatabaseToggles() {
    return this.settings.databaseTogglesView();
  }

  @Patch('databases')
  async setDatabaseToggle(@Body() body: { toggle?: string; enabled?: boolean }) {
    const toggle = String(body?.toggle ?? '') as DatabaseToggle;
    if (!(toggle in DATABASE_TOGGLES)) throw new BadRequestException('Unknown database setting');
    await this.settings.setDatabaseToggle(toggle, Boolean(body?.enabled));
    return this.settings.databaseTogglesView();
  }
}
