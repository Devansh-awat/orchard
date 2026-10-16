import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { EngineService } from './engine.service';

@Auth()
@Controller('engine')
export class EngineHealthController {
  constructor(private readonly mirror: EngineService) {}

  @Get('health')
  async health() {
    return this.mirror.health();
  }
}
