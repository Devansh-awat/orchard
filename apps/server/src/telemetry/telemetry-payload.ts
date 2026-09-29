import { relative } from 'node:path';

export type TelemetryProps = Record<string, string | number | boolean | null>;

export interface ExceptionFrame {
  platform: 'node:javascript';
  function: string;
  filename: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

export interface ScrubbedException {
  type: string;
  code: string | null;
  frames: ExceptionFrame[];
}

const FRAME = /^\s*at (?:(?:async )?(.+?) \()?(?:file:\/\/)?(.+?):(\d+):(\d+)\)?$/;
const SAFE_CODE = /^(?:P\d{4}|E[A-Z_]{2,30}|ERR_[A-Z_]{2,60})$/;
const MAX_FRAMES = 40;

function framePath(file: string): string {
  const vendored = file.lastIndexOf('node_modules/');
  if (vendored !== -1) return file.slice(vendored);
  if (file.startsWith('node:')) return file;
  const local = relative(process.cwd(), file);
  if (local.startsWith('..')) return file.split('/').pop() ?? 'unknown';
  return local;
}

export function scrubStack(stack: string | undefined): ExceptionFrame[] {
  if (!stack) return [];
  const frames: ExceptionFrame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const [, fn, file, lineno, colno] = match;
    frames.push({
      platform: 'node:javascript',
      function: fn ?? '<anonymous>',
      filename: framePath(file),
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !file.includes('node_modules') && !file.startsWith('node:')
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

export function scrubException(error: unknown): ScrubbedException {
  if (!(error instanceof Error)) return { type: typeof error, code: null, frames: [] };
  const rawCode = (error as { code?: unknown }).code;
  const code = typeof rawCode === 'string' && SAFE_CODE.test(rawCode) ? rawCode : null;
  const type =
    error.constructor?.name && error.constructor.name !== 'Object'
      ? error.constructor.name
      : error.name;
  return { type: type || 'Error', code, frames: scrubStack(error.stack) };
}
