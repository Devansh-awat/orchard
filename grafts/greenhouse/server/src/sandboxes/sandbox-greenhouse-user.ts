import { NotFoundException } from '@nestjs/common';
import type { UsersService } from '../core/users.service';
import type { AnalyticsService } from '../core/analytics.service';

export type GreenhouseUser = Awaited<ReturnType<UsersService['findOrCreateByClerkId']>>;

export async function resolveGreenhouseUser(
  users: Pick<UsersService, 'findOrCreateByClerkId'>,
  analytics: Pick<AnalyticsService, 'configured' | 'isFeatureEnabled'>,
  req: any
): Promise<GreenhouseUser> {
  const user = await users.findOrCreateByClerkId(req.user.sub, { email: req.user.email });
  if (analytics.configured && !(await analytics.isFeatureEnabled('greenhouse', user.id))) {
    throw new NotFoundException('Sandbox feature is not enabled for your account');
  }
  return user;
}
