import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

export function sandboxFeatureEnabled(): boolean {
  return process.env.SANDBOX_ENABLED === 'true';
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
