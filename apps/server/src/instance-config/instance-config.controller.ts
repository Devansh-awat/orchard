import { Body, Controller, Delete, Get, NotFoundException, Param, Put } from '@nestjs/common';
import { InstanceConfigService, ConfigValues } from './instance-config.service';
import { SECTIONS, sectionById } from './instance-config.sections';

// Superadmin-only (default-deny: no @Auth()/@Public() decorator, so the global
// SuperAdminGuard requires a superadmin).
@Controller('admin/instance-config')
export class InstanceConfigController {
  constructor(private readonly config: InstanceConfigService) {}

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
