import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { AnalyticsService } from '../../analytics/analytics.service';
import { bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class FlagsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'flags',
    version: 1,
    status: 'stable',
    capability: 'flags'
  };

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService
  ) {
    bindGraft(parent, FlagsDoorV1.meta);
  }

  get configured(): boolean {
    return this.analytics.configured;
  }

  isEnabled(key: string, distinctId: string): Promise<boolean> {
    return this.analytics.isFeatureEnabled(key, distinctId);
  }
}
