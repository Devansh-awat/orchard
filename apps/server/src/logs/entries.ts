import { groupLines, type LogEntry } from '../observability/observability.service';
import type { LogRow } from './victoria-logs.service';

export function rowsToEntries(rows: LogRow[]): LogEntry[] {
  const byPod = new Map<string, LogRow[]>();
  for (const row of rows) {
    const pod = row.pod ?? '';
    const list = byPod.get(pod);
    if (list) list.push(row);
    else byPod.set(pod, [row]);
  }
  const out: { entry: LogEntry; t: number }[] = [];
  for (const [pod, list] of byPod) {
    list.sort((a, b) => (a._time < b._time ? -1 : a._time > b._time ? 1 : 0));
    const levels = new Map<string, string>();
    const lines = list.map((r) => {
      const msg = (r._msg ?? r.message ?? '').replace(/\n/g, ' ');
      if (r.level) levels.set(r._time, r.level.toUpperCase());
      return `${r._time} ${msg}`;
    });
    for (const entry of groupLines(lines)) {
      const stored = entry.timestamp ? levels.get(entry.timestamp) : undefined;
      out.push({
        entry: {
          ...entry,
          level: entry.level ?? stored,
          metadata: { ...(entry.metadata ?? {}), pod: pod || undefined }
        },
        t: Date.parse(entry.timestamp ?? '') || 0
      });
    }
  }
  return out.sort((a, b) => b.t - a.t).map((o) => o.entry);
}
