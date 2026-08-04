import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

export function sandboxFeatureEnabled(): boolean {
  if (process.env.SANDBOX_ENABLED === 'true') return true;
  if (process.env.SANDBOX_ENABLED === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

@Injectable()
export class SandboxEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!sandboxFeatureEnabled()) {
      throw new NotFoundException('Sandbox feature is not enabled on this server');
    }
    return true;
  }
}
