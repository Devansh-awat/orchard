import { EventEmitter } from 'events';
import WebSocket from 'ws';

export class DaemonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

export class DaemonUnavailableError extends Error {}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PING_MS = 20_000;

export class DaemonConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  closed = false;
  version: string | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly connectTimeoutMs = 1500
  ) {
    super();
    this.setMaxListeners(0);
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${this.token}` },
        handshakeTimeout: this.connectTimeoutMs,
        perMessageDeflate: true,
        maxPayload: 64 * 1024 * 1024
      });
      this.ws = ws;
      let opened = false;
      const fail = (err: Error) => {
        if (opened) return;
        opened = true;
        this.shutdown(err);
        reject(new DaemonUnavailableError(err.message));
      };
      const timer = setTimeout(
        () => fail(new Error('daemon connect timed out')),
        this.connectTimeoutMs + 500
      );
      ws.once('open', () => {
        clearTimeout(timer);
        if (opened) return;
        opened = true;
        this.pingTimer = setInterval(() => {
          try {
            ws.ping();
          } catch {}
        }, PING_MS);
        this.pingTimer.unref?.();
        resolve();
      });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        fail(new Error(`daemon answered ${res.statusCode}`));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        if (!opened) fail(err);
        else this.shutdown(err);
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (!opened) fail(new Error('daemon closed the connection'));
        else this.shutdown(new Error('daemon connection closed'));
      });
      ws.on('message', (data) => this.receive(data.toString()));
    });
  }

  private receive(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg && typeof msg.method === 'string' && msg.id === undefined) {
      this.emit('notification', msg.method, msg.params);
      return;
    }
    if (msg && typeof msg.method === 'string') return;
    const id = typeof msg?.id === 'number' ? msg.id : Number(msg?.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new DaemonRpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  call<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (this.closed || !ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new DaemonUnavailableError('daemon is not connected'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }), (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new DaemonUnavailableError(err.message));
      });
    });
  }

  private shutdown(err: Error) {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`daemon connection lost: ${err.message}`));
      this.pending.delete(id);
    }
    try {
      this.ws?.terminate();
    } catch {}
    this.emit('close', err);
  }

  close() {
    this.shutdown(new Error('closed'));
  }
}
