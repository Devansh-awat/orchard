import { Controller, Get, Post, Body, Request } from '@nestjs/common';
import { Public, Auth } from '../auth/decorators';
import { SetupService } from './setup.service';

@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  status() {
    return this.setup.getStatus();
  }

  @Auth()
  @Post('claim')
  claim(@Request() req, @Body() body: { token?: string }) {
    return this.setup.claim(req.user.sub, body?.token ?? '');
  }
}
