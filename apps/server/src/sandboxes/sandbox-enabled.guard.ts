import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';

const TTL_MS = 10_000;

@Injectable()
export class SandboxEnabledGuard implements CanActivate {
  private cached: { at: number; value: boolean } | null = null;

  constructor(private readonly settings: InstanceSettingsService) {}

  async canActivate(): Promise<boolean> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > TTL_MS) {
      this.cached = { at: now, value: await this.settings.isSandboxesEnabled() };
    }
    if (!this.cached.value) {
      throw new NotFoundException('Sandbox feature is not enabled on this server');
    }
    return true;
  }
}
