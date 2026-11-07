import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { ScanResultGuard } from './scan-result.guard';
import { SCAN_TOKEN_HEADER } from './trivy-job';
import { TrivyScanService } from './trivy-scan.service';

@Public()
@UseGuards(ScanResultGuard)
@Controller('internal/image-scans')
export class ImageScanResultController {
  constructor(private readonly trivy: TrivyScanService) {}

  @Post(':id/result')
  @HttpCode(204)
  async result(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Body() body: unknown) {
    const header = req.headers[SCAN_TOKEN_HEADER];
    await this.trivy.complete(id, typeof header === 'string' ? header : undefined, body);
  }
}
