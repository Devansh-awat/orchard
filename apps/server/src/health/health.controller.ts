import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { join } from 'path';
import { readFileSync } from 'fs';
import { Public } from '../auth/decorators';

const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));

@SkipThrottle()
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  getHealth() {
    return { status: 'ok', message: 'Server is running', version };
  }
}
