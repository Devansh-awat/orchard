import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

export const SNAPSHOT_SCROLLBACK = Math.max(
  0,
  Math.min(5000, Number(process.env.EXEC_SNAPSHOT_SCROLLBACK ?? 500) || 0)
);
export const SNAPSHOT_MAX_BYTES = 512 * 1024;

export interface ScreenSnapshot {
  data: string;
  truncated: boolean;
}

export class SessionScreen {
  private readonly term: Terminal;

  private readonly serializer: SerializeAddon;

  private disposed = false;

  private readonly scrollback: number;

  constructor(cols: number, rows: number, scrollback = SNAPSHOT_SCROLLBACK) {
    this.scrollback = scrollback;
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  write(chunk: Buffer | string): void {
    if (this.disposed) return;
    this.term.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
  }

  async snapshot(): Promise<ScreenSnapshot> {
    if (this.disposed) return { data: '', truncated: false };
    await new Promise<void>((resolve) => this.term.write('', resolve));
    const full = this.serializer.serialize({ scrollback: this.scrollback });
    if (Buffer.byteLength(full, 'utf8') <= SNAPSHOT_MAX_BYTES) {
      return { data: full, truncated: false };
    }
    return { data: this.serializer.serialize({ scrollback: 0 }), truncated: true };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
  }
}
