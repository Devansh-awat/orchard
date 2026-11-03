import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';

// Gates the tenant-facing node-pool endpoints behind the userspace-scheduling
// toggle (admin-panel setting, overridable by the USERSPACE_NODE_SCHEDULING env
// var). Hosted Orchard leaves it off: tenants never see scheduling. 404s when
// disabled (mirrors GroveEnabledGuard) so the feature is invisible, not
// forbidden.
@Injectable()
export class UserspaceSchedulingGuard implements CanActivate {
  constructor(private readonly settings: InstanceSettingsService) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.settings.isUserspaceSchedulingEnabled())) throw new NotFoundException();
    return true;
  }
}
