export type Proto = 1 | 2;

export const PROTO_V2: Proto = 2;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const MIN_COLS = 2;
export const MIN_ROWS = 1;
export const MAX_DIMENSION = 1000;

export interface Handshake {
  proto: Proto;
  cols: number;
  rows: number;
}

export type StatusKind =
  | 'reconnected'
  | 'expired'
  | 'moved'
  | 'denied'
  | 'truncated'
  | 'limit'
  | 'revoked'
  | 'failed'
  | 'exited';

export type ClientFrame =
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'stdin'; data: string | Buffer }
  | { kind: 'ignore' };

export function clampDimension(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(MAX_DIMENSION, Math.floor(n)));
}

export function parseHandshake(params: URLSearchParams): Handshake {
  return {
    proto: params.get('proto') === '2' ? 2 : 1,
    cols: clampDimension(params.get('cols'), DEFAULT_COLS, MIN_COLS),
    rows: clampDimension(params.get('rows'), DEFAULT_ROWS, MIN_ROWS)
  };
}

export function parseClientFrame(
  data: Buffer | string,
  isBinary: boolean | undefined
): ClientFrame {
  if (isBinary !== false && typeof data !== 'string') return { kind: 'stdin', data };
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (!text.startsWith('{')) return { kind: 'stdin', data: text };
  let frame: { type?: unknown; cols?: unknown; rows?: unknown; data?: unknown } | null = null;
  try {
    frame = JSON.parse(text);
  } catch {
    return { kind: 'stdin', data: text };
  }
  if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
    return { kind: 'stdin', data: text };
  }
  if (frame.type === 'resize') {
    return {
      kind: 'resize',
      cols: clampDimension(frame.cols, DEFAULT_COLS, MIN_COLS),
      rows: clampDimension(frame.rows, DEFAULT_ROWS, MIN_ROWS)
    };
  }
  if (frame.type === 'input' && typeof frame.data === 'string') {
    return { kind: 'stdin', data: frame.data };
  }
  return { kind: 'ignore' };
}

export function rejectionCloseCode(status: number): number {
  switch (status) {
    case 400:
      return 4400;
    case 401:
      return 4401;
    case 403:
      return 4403;
    case 404:
      return 4404;
    default:
      return 1011;
  }
}

export function statusFrame(kind: StatusKind, message: string): string {
  return JSON.stringify({ type: 'status', kind, message });
}

export function statusBytes(message: string, tone: 'quiet' | 'error' = 'quiet'): string {
  const color = tone === 'error' ? '\x1b[31m' : '\x1b[90m';
  return `\r\n\x1b[2K${color}--- ${message} ---\x1b[0m\r\n`;
}

export const CLEAR_SCREEN_AND_SCROLLBACK = '\x1b[H\x1b[2J\x1b[3J';
