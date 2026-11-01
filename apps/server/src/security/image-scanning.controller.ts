import { BadRequestException, Body, Controller, Get, Patch } from '@nestjs/common';
import {
  InstanceSettingsService,
  parseImageScanner
} from '../instance-settings/instance-settings.service';
import { SecurityService } from './security.service';

@Controller('admin/instance-settings')
export class ImageScanningController {
  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly security: SecurityService
  ) {}

  private async state() {
    const [state, options, defaultValue] = await Promise.all([
      this.security.scannerState(),
      this.security.scannerOptions(),
      this.security.defaultScanner()
    ]);
    return { ...state, defaultValue, options };
  }

  @Get('image-scanning')
  async get() {
    return this.state();
  }

  @Patch('image-scanning')
  async set(@Body() body: { value?: unknown }) {
    const value = parseImageScanner(typeof body?.value === 'string' ? body.value : null);
    if (!value) throw new BadRequestException('value must be one of off, harbor, trivy');
    const option = (await this.security.scannerOptions()).find((o) => o.value === value);
    if (option && !option.available) throw new BadRequestException(option.reason);
    await this.settings.setImageScanner(value);
    return this.state();
  }
}
