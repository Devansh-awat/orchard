import { NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { UsersService } from '../users/users.service';
import type { AnalyticsService } from '../analytics/analytics.service';

export async function resolveGreenhouseUser(
  users: Pick<UsersService, 'findOrCreateByClerkId'>,
  analytics: Pick<AnalyticsService, 'configured' | 'isFeatureEnabled'>,
  req: any
): Promise<User> {
  const user = await users.findOrCreateByClerkId(req.user.sub, { email: req.user.email });
  if (analytics.configured && !(await analytics.isFeatureEnabled('greenhouse', user.id))) {
    throw new NotFoundException('Sandbox feature is not enabled for your account');
  }
  return user;
}
