import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  NestInterceptor,
  Param,
  Query,
  Request,
  Res
} from '@nestjs/common';
import type { Response } from 'express';
import { mergeMap, type Observable } from 'rxjs';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from './project-access.service';
import { parseRolloutTimeout, RolloutStatusService } from './rollout-status.service';

@Injectable()
export class RolloutPinInterceptor implements NestInterceptor {
  constructor(private readonly rollout: RolloutStatusService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const id: string | undefined = req?.params?.id;
    const since = new Date();
    return next.handle().pipe(
      mergeMap(async (result) => {
        if (!id || !result || typeof result !== 'object' || Array.isArray(result)) return result;
        const pin = await this.rollout.rolloutPin(id, since).catch(() => null);
        return pin ? { ...result, ...pin } : result;
      })
    );
  }
}

@Auth()
@Controller('deployments')
export class RolloutController {
  constructor(
    private readonly projectAccess: ProjectAccessService,
    private readonly rollout: RolloutStatusService
  ) {}

  @Get(':id/rollout')
  async getRollout(
    @Param('id') id: string,
    @Request() req,
    @Res({ passthrough: true }) res: Response,
    @Query('wait') wait?: string,
    @Query('timeout') timeout?: string,
    @Query('release') release?: string,
    @Query('since') since?: string
  ) {
    const { access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.on('close', onClose);
    try {
      return await this.rollout.rollout(id, {
        canEdit: access.canEdit,
        wait: wait === '1' || wait === 'true',
        timeoutMs: parseRolloutTimeout(timeout),
        releaseId: release || undefined,
        since: since || undefined,
        signal: abort.signal
      });
    } finally {
      res.off('close', onClose);
    }
  }
}
