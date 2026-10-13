import { Controller, Get, Patch, Body } from '@nestjs/common';
import { InstanceSettingsService } from './instance-settings.service';

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

}
