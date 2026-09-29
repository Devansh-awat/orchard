import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';

@Controller('admin/telemetry')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Get()
  state() {
    return this.telemetry.getState();
  }

  @Get('preview')
  preview() {
    return this.telemetry.preview();
  }

  @Put()
  setConsent(@Body() body: { enabled?: boolean }) {
    if (typeof body?.enabled !== 'boolean')
      throw new BadRequestException('enabled must be a boolean');
    return this.telemetry.setConsent(body.enabled);
  }
}
