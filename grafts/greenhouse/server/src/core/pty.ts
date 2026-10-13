import type { Readable, Writable } from 'stream';

export interface PtyHandle {
  stdin: Writable;
  output: Readable;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  close(): void;
  exited: Promise<{ ok: boolean; message: string | null }>;
}
