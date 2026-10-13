import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { loadedGrafts } from '../grafts/graft-registry';
import { InstanceSettingsService } from './instance-settings.service';

@Controller('instance')
export class InstanceFeaturesController {
  constructor(private readonly settings: InstanceSettingsService) {}

  @Auth()
  @Get('features')
  async features() {
    const grafts = loadedGrafts().map((g) => g.id);
    return {
      mcp: await this.settings.isMcpEnabled(),
      grafts,
      sandboxes: grafts.includes('greenhouse')
    };
  }
}
