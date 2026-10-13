import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import { VictoriaMetricsService, escapeLabel } from '../../metrics/victoria-metrics.service';
import { bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class MetricsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'metrics',
    version: 1,
    status: 'stable',
    capability: 'metrics'
  };

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef
  ) {
    bindGraft(parent, MetricsDoorV1.meta);
  }

  private get vm(): VictoriaMetricsService | null {
    try {
      return this.moduleRef.get(VictoriaMetricsService, { strict: false });
    } catch {
      return null;
    }
  }

  get configured(): boolean {
    return !!this.vm;
  }

  async queryInstant(promql: string): Promise<number | null> {
    return this.vm ? this.vm.queryInstant(promql) : null;
  }

  escapeLabel(value: string): string {
    return escapeLabel(value);
  }
}
