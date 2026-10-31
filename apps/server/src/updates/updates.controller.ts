import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { UpdatesService } from './updates.service';

@Controller('updates')
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Auth()
  @Get('latest')
  latest() {
    return this.updates.latest();
  }
}
