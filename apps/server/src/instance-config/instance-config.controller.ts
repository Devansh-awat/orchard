import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Request
} from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { InstanceConfigService, ConfigValues } from './instance-config.service';
import { EMAIL, SECTIONS, STORAGE, sectionById } from './instance-config.sections';
import { probeStorage, storageProbeTarget } from './storage-probe';

// Superadmin-only (default-deny: no @Auth()/@Public() decorator, so the global
// SuperAdminGuard requires a superadmin).
@Controller('admin/instance-config')
export class InstanceConfigController {
  constructor(
    private readonly config: InstanceConfigService,
    private readonly email: EmailService
  ) {}

  @Get()
  list() {
    return SECTIONS.map((section) => this.config.state(section));
  }

  @Get(':id')
  one(@Param('id') id: string) {
    const section = sectionById(id);
    if (!section) throw new NotFoundException('Unknown configuration section');
    return this.config.state(section);
  }

  @Post('storage/test')
  async testStorage(@Body() body: ConfigValues) {
    return probeStorage(storageProbeTarget(body ?? {}, this.config.all(STORAGE)));
  }

  @Post('email/test')
  async testEmail(@Request() req, @Body() body: ConfigValues & { to?: string }) {
    const { to, ...values } = body ?? {};
    return this.email.sendTestEmail(
      { ...this.config.all(EMAIL), ...EmailService.filled(values) },
      (to || req.user?.email || '').trim()
    );
  }

  @Put(':id')
  async save(@Param('id') id: string, @Body() body: ConfigValues) {
    const section = sectionById(id);
    if (!section) throw new NotFoundException('Unknown configuration section');
    await this.config.save(section, body ?? {});
    return this.config.state(section);
  }

  @Delete(':id')
  async clear(@Param('id') id: string) {
    const section = sectionById(id);
    if (!section) throw new NotFoundException('Unknown configuration section');
    await this.config.clear(section);
    return this.config.state(section);
  }
}
