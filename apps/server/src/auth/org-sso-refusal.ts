import { ForbiddenException, HttpException } from '@nestjs/common';
import { requestAuthStorage } from './request-context';

export function orgSsoRefusal(exception: unknown): HttpException | null {
  const ctx = requestAuthStorage.getStore();
  if (!ctx?.orgSsoRefused || ctx.browserSession) return null;
  if (!(exception instanceof HttpException)) return null;
  if (![403, 404].includes(exception.getStatus())) return null;
  return new ForbiddenException({
    error: 'org_sso_required',
    message:
      'This organization requires single sign-on. Sign in with it, then create a new token or reconnect this client.'
  });
}
