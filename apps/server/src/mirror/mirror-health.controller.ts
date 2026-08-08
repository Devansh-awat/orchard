import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { MirrorService } from './mirror.service';

@Auth()
@Controller('engine')
export class MirrorHealthController {
  constructor(private readonly mirror: MirrorService) {}

  @Get('health')
  async health() {
    return this.mirror.health();
  }
}
