import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  getHealth() {
    return { status: 'ok', message: 'Server is running' };
  }
}

