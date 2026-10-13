import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { AnalyticsService } from '../core/analytics.service';

export const GREENHOUSE_FLAG = 'greenhouse';

@Injectable()
export class SandboxEnabledGuard implements CanActivate {
  constructor(
    @Inject(AnalyticsService)
    private readonly analytics: Pick<AnalyticsService, 'configured' | 'isFeatureEnabled'>
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.analytics.configured) return true;
    const request = context.switchToHttp().getRequest<{ auth?: { userId?: string } }>();
    const userId = request.auth?.userId;
    if (userId && (await this.analytics.isFeatureEnabled(GREENHOUSE_FLAG, userId))) return true;
    throw new NotFoundException('Sandbox feature is not enabled for your account');
  }
}
