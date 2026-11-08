import { Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { SuperAdmin } from '../auth/decorators';
import { DoctorService } from './doctor.service';
import { SelfTestService } from './selftest.service';

@SuperAdmin()
@Controller('admin/doctor')
export class DoctorController {
  constructor(
    private readonly doctor: DoctorService,
    private readonly selftest: SelfTestService
  ) {}

  @Get()
  async report(@Req() req: any) {
    return this.doctor.report(req);
  }

  @Post('selftest')
  startSelfTest(@Req() req: any) {
    return this.selftest.start(req.auth?.userId ?? null);
  }

  @Get('selftest/:id')
  getSelfTest(@Param('id') id: string) {
    const run = this.selftest.get(id);
    if (!run) throw new NotFoundException('No such self-test run on this server');
    return run;
  }
}
