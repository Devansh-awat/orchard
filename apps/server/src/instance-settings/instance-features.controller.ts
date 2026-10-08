import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { InstanceSettingsService } from './instance-settings.service';

// What this instance offers, for a signed-in browser deciding what to render.
// Separate from admin/instance-settings because that surface is superadmin-only
// and this is the opposite: every user needs it, none of them may change it.
@Controller('instance')
export class InstanceFeaturesController {
  constructor(private readonly settings: InstanceSettingsService) {}

  @Auth()
  @Get('features')
  async features() {
    const [mcp, sandboxes] = await Promise.all([
      this.settings.isMcpEnabled(),
      this.settings.isSandboxesEnabled()
    ]);
    return { mcp, sandboxes };
  }
}
