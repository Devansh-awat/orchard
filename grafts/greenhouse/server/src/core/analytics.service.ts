import { Inject, Injectable } from '@nestjs/common';
import { Doors, type FlagsDoor } from '@orchard/graft-sdk/server';

@Injectable()
export class AnalyticsService {
  constructor(@Inject(Doors.flags) private readonly flags: FlagsDoor) {}

  get configured(): boolean {
    return this.flags.configured;
  }

  isFeatureEnabled(key: string, distinctId: string): Promise<boolean> {
    return this.flags.isEnabled(key, distinctId);
  }
}
