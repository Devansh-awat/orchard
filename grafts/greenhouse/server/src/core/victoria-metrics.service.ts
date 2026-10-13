import { Inject, Injectable } from '@nestjs/common';
import { Doors, type MetricsDoor } from '@orchard/graft-sdk/server';

export function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

@Injectable()
export class VictoriaMetricsService {
  constructor(@Inject(Doors.metrics) private readonly metrics: MetricsDoor) {}

  async queryInstant(promql: string): Promise<number | null> {
    return this.metrics.queryInstant(promql);
  }
}
