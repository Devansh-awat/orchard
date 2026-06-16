import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators';

@SkipThrottle()
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  getHealth() {
    return { status: 'ok', message: 'Server is running' };
  }
}

