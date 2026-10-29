import { Controller, Get, Param, Query, Request } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from '../projects/project-access.service';
import { DiagnosisService } from './diagnosis.service';

@Auth()
@Controller('deployments')
export class DiagnosisController {
  constructor(
    private readonly diagnosis: DiagnosisService,
    private readonly access: ProjectAccessService
  ) {}

  @Get(':id/diagnosis')
  async diagnose(@Param('id') id: string, @Request() req, @Query('tz') tz?: string) {
    const { user, access } = await this.access.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.diagnosis.diagnose(id, { userId: user.id, canEdit: !!access.canEdit, tz });
  }
}
