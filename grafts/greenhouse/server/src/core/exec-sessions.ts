import { PassThrough } from 'stream';

export class ResizableOutput extends PassThrough {
  columns = 80;

  rows = 24;

  setSize(columns: number, rows: number): void {
    if (!Number.isFinite(columns) || !Number.isFinite(rows)) return;
    const nextCols = Math.max(1, Math.min(1000, Math.floor(columns)));
    const nextRows = Math.max(1, Math.min(1000, Math.floor(rows)));
    if (nextCols === this.columns && nextRows === this.rows) return;
    this.columns = nextCols;
    this.rows = nextRows;
    this.emit('resize');
  }
}

export interface SandboxExecTarget {
  kind: 'sandbox';
  key: string;
  sandboxId: string;
  sessionId: string | null;
  index: string;
  mode: 'rw' | 'ro';
  worktreePath: string | null;
  terminalUserId?: string | null;
}

export function sandboxTargetKey(target: {
  sandboxId: string;
  sessionId: string | null;
  index: string;
  mode: 'rw' | 'ro';
  terminalUserId?: string | null;
}): string {
  const base = `sandbox:${target.sandboxId}/${target.sessionId ?? '-'}/${target.index}/${target.mode}`;
  return target.terminalUserId ? `${base}/${target.terminalUserId}` : base;
}

export function sandboxExecTarget(
  fields: Omit<SandboxExecTarget, 'kind' | 'key'> & { kind?: string; key?: string }
): SandboxExecTarget {
  const { kind: _kind, key: _key, ...rest } = fields;
  return { ...rest, kind: 'sandbox', key: sandboxTargetKey(rest) };
}

export function isSandboxTarget(target: { kind: string }): target is SandboxExecTarget {
  return target.kind === 'sandbox' && 'sandboxId' in target;
}
