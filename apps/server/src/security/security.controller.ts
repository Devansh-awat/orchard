import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Request,
  ServiceUnavailableException
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from '../projects/project-access.service';
import { HarborScanError } from './harbor-scan.client';
import { ScanNotPossibleError, SecurityService } from './security.service';

@Auth()
@Controller('deployments')
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly access: ProjectAccessService
  ) {}

  private userData(req: any) {
    return {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    };
  }

  @Get(':id/security')
  async report(@Param('id') id: string, @Request() req) {
    const { access } = await this.access.assertDeploymentView(id, req.user.sub, this.userData(req));
    return this.security.report(id, !!access.canEdit);
  }

  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  @Post(':id/security/scan')
  async scan(@Param('id') id: string, @Request() req) {
    const { access } = await this.access.assertDeploymentView(id, req.user.sub, this.userData(req));
    if (!access.canEdit) {
      throw new ForbiddenException('Your role does not allow you to scan this app');
    }
    try {
      return await this.security.rescan(id);
    } catch (err) {
      if (err instanceof ScanNotPossibleError) throw new BadRequestException(err.message);
      if (err instanceof HarborScanError) {
        if (err.kind === 'not_found')
          throw new NotFoundException('The image is not in the registry');
        if (err.kind === 'not_scannable')
          throw new BadRequestException('This image cannot be scanned');
        throw new ServiceUnavailableException('The image scanner is unavailable');
      }
      throw err;
    }
  }
}
