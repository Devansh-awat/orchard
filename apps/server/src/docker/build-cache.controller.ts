import { BadRequestException, Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { BuildCacheService } from './build-cache.service';

@Controller('admin/build-cache')
export class BuildCacheController {
  constructor(private readonly cache: BuildCacheService) {}

  @Get()
  async view() {
    return this.cache.view();
  }

  @Patch()
  async update(@Body() body: unknown) {
    try {
      return await this.cache.update(body);
    } catch (err) {
      if (err instanceof Error && !('status' in err)) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Get('usage')
  async usage() {
    return this.cache.usage();
  }

  @Post('prune')
  @HttpCode(200)
  async prune(@Body() body: { mode?: string }) {
    const mode = body?.mode ?? 'idle';
    if (mode !== 'idle' && mode !== 'all') {
      throw new BadRequestException('mode must be idle or all');
    }
    return this.cache.prune(mode);
  }
}
