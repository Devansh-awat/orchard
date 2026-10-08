import type { SandboxRole } from '../sandbox-access.service';

export const LIVE_MAX_FRAME_BYTES = 64 * 1024;
export const LIVE_MAX_DRAFT_CHARS = 4000;
export const LIVE_MAX_COMMENT_CHARS = 4000;
export const LIVE_MAX_ROOMS_PER_CONNECTION = 8;
export const LIVE_PALETTE_SIZE = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_ID_RE = /^ses_[A-Za-z0-9]{1,60}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export type LiveMessageType =
  | 'hello'
  | 'presence'
  | 'draft'
  | 'comment'
  | 'follow'
  | 'yjs'
  | 'yjs-awareness'
  | 'yjs-save'
  | 'yjs-reload'
  | 'yjs-leave'
  | 'ping';

export const LIVE_MESSAGE_TYPES: readonly LiveMessageType[] = [
  'hello',
  'presence',
  'draft',
  'comment',
  'follow',
  'yjs',
  'yjs-awareness',
  'yjs-save',
  'yjs-reload',
  'yjs-leave',
  'ping'
];

export type LiveMinRole = 'viewer' | 'collaborator';

export const LIVE_MESSAGE_ROLE: Record<LiveMessageType, LiveMinRole> = {
  hello: 'viewer',
  presence: 'viewer',
  draft: 'collaborator',
  comment: 'collaborator',
  follow: 'viewer',
  yjs: 'viewer',
  'yjs-awareness': 'viewer',
  'yjs-save': 'collaborator',
  'yjs-reload': 'viewer',
  'yjs-leave': 'viewer',
  ping: 'viewer'
};

export interface LiveView {
  tab: string | null;
  file?: string | null;
  line?: number | null;
  col?: number | null;
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number } | null;
  scrollTop?: number | null;
}

export type ClientFrame =
  | { t: 'hello'; sid: string | null; view: LiveView | null }
  | { t: 'presence'; sid: string | null; view: LiveView }
  | { t: 'draft'; sid: string; chatId: string; text: string }
  | { t: 'comment'; sid: string; chatId: string; body: string }
  | { t: 'follow'; target: string | null }
  | { t: 'yjs'; room: string; b64: string; gen: string | null }
  | { t: 'yjs-awareness'; room: string; b64: string }
  | { t: 'yjs-save'; room: string }
  | { t: 'yjs-reload'; room: string }
  | { t: 'yjs-leave'; room: string }
  | { t: 'ping' };

export type ParseResult = { ok: true; frame: ClientFrame } | { ok: false; error: string };

export function liveRoleAllows(role: SandboxRole, min: LiveMinRole): boolean {
  if (min === 'viewer') return true;
  return role === 'owner' || role === 'collaborator';
}

export function canWrite(role: SandboxRole): boolean {
  return liveRoleAllows(role, 'collaborator');
}

function isStrippedCode(code: number): boolean {
  if (code <= 0x08 || code === 0x0b || code === 0x0c) return true;
  if (code >= 0x0e && code <= 0x1f) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  return code >= 0x2066 && code <= 0x2069;
}

export function stripControl(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (!isStrippedCode(value.charCodeAt(i))) out += value[i];
  }
  return out;
}

export function sanitizeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > max) return null;
  return stripControl(value);
}

export function colorIndexFor(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return Math.abs(hash) % LIVE_PALETTE_SIZE;
}

function int(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n < min || n > max ? null : n;
}

function shortString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = stripControl(value);
  return clean.length > max ? clean.slice(0, max) : clean;
}

export function sanitizeView(value: unknown): LiveView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const view: LiveView = { tab: shortString(raw.tab, 200) };
  const file = shortString(raw.file, 1024);
  if (file !== null) view.file = file;
  const line = int(raw.line, 0, 10_000_000);
  if (line !== null) view.line = line;
  const col = int(raw.col, 0, 100_000);
  if (col !== null) view.col = col;
  const scrollTop = int(raw.scrollTop, 0, 1_000_000_000);
  if (scrollTop !== null) view.scrollTop = scrollTop;
  const sel = raw.selection as Record<string, unknown> | null | undefined;
  if (sel && typeof sel === 'object') {
    const startLine = int(sel.startLine, 0, 10_000_000);
    const startCol = int(sel.startCol, 0, 100_000);
    const endLine = int(sel.endLine, 0, 10_000_000);
    const endCol = int(sel.endCol, 0, 100_000);
    if (startLine !== null && startCol !== null && endLine !== null && endCol !== null) {
      view.selection = { startLine, startCol, endLine, endCol };
    }
  }
  return view;
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isChatId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID_RE.test(value);
}

export interface ParsedRoom {
  sid: string;
  path: string;
}

export function parseRoom(
  room: unknown,
  normalizePath: (value: unknown) => string | null
): ParsedRoom | null {
  if (typeof room !== 'string' || room.length > 1100) return null;
  if (!room.startsWith('file:')) return null;
  const rest = room.slice(5);
  const colon = rest.indexOf(':');
  if (colon !== 36) return null;
  const sid = rest.slice(0, 36);
  if (sid !== sid.toLowerCase() || !isSessionId(sid)) return null;
  const path = normalizePath(rest.slice(37));
  if (!path || path !== rest.slice(37)) return null;
  return { sid, path };
}

function b64(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4) return null;
  if (!B64_RE.test(value)) return null;
  return value;
}

export function parseClientFrame(raw: string): ParseResult {
  if (raw.length > LIVE_MAX_FRAME_BYTES) return { ok: false, error: 'frame_too_large' };
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'bad_frame' };
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'bad_json' };
  }
  const t = data.t;
  const sid = data.sid === undefined || data.sid === null ? null : data.sid;
  switch (t) {
    case 'hello': {
      if (sid !== null && !isSessionId(sid)) return { ok: false, error: 'bad_sid' };
      return {
        ok: true,
        frame: { t, sid: sid ? String(sid).toLowerCase() : null, view: sanitizeView(data.view) }
      };
    }
    case 'presence': {
      if (sid !== null && !isSessionId(sid)) return { ok: false, error: 'bad_sid' };
      const view = sanitizeView(data.view);
      if (!view) return { ok: false, error: 'bad_view' };
      return { ok: true, frame: { t, sid: sid ? String(sid).toLowerCase() : null, view } };
    }
    case 'draft': {
      if (!isSessionId(sid)) return { ok: false, error: 'bad_sid' };
      if (!isChatId(data.chatId)) return { ok: false, error: 'bad_chat' };
      const text = sanitizeText(data.text, LIVE_MAX_DRAFT_CHARS);
      if (text === null) return { ok: false, error: 'bad_text' };
      return { ok: true, frame: { t, sid: sid.toLowerCase(), chatId: data.chatId, text } };
    }
    case 'comment': {
      if (!isSessionId(sid)) return { ok: false, error: 'bad_sid' };
      if (!isChatId(data.chatId)) return { ok: false, error: 'bad_chat' };
      const body = sanitizeText(data.body, LIVE_MAX_COMMENT_CHARS);
      if (body === null || !body.trim()) return { ok: false, error: 'bad_body' };
      return { ok: true, frame: { t, sid: sid.toLowerCase(), chatId: data.chatId, body } };
    }
    case 'follow': {
      const target = data.target === undefined || data.target === null ? null : data.target;
      if (target !== null && !isSessionId(target)) return { ok: false, error: 'bad_target' };
      return { ok: true, frame: { t, target: target ? String(target).toLowerCase() : null } };
    }
    case 'yjs': {
      if (typeof data.room !== 'string') return { ok: false, error: 'bad_room' };
      const payload = b64(data.b64, LIVE_MAX_FRAME_BYTES);
      if (!payload) return { ok: false, error: 'bad_payload' };
      const gen = typeof data.gen === 'string' && data.gen.length <= 64 ? data.gen : null;
      return { ok: true, frame: { t, room: data.room, b64: payload, gen } };
    }
    case 'yjs-awareness': {
      if (typeof data.room !== 'string') return { ok: false, error: 'bad_room' };
      const payload = b64(data.b64, 16 * 1024);
      if (!payload) return { ok: false, error: 'bad_payload' };
      return { ok: true, frame: { t, room: data.room, b64: payload } };
    }
    case 'yjs-save':
    case 'yjs-reload':
    case 'yjs-leave': {
      if (typeof data.room !== 'string') return { ok: false, error: 'bad_room' };
      return { ok: true, frame: { t, room: data.room } };
    }
    case 'ping':
      return { ok: true, frame: { t } };
    default:
      return { ok: false, error: 'unknown_type' };
  }
}

export class TokenBucket {
  private tokens: number;

  private updatedAt: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = burst;
    this.updatedAt = now();
  }

  take(): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.updatedAt) / 1000;
    this.updatedAt = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export type LimitClass =
  | 'draft'
  | 'comment'
  | 'presence'
  | 'yjs'
  | 'awareness'
  | 'control'
  | 'room';

export const LIVE_LIMITS: Record<LimitClass, { rate: number; burst: number }> = {
  draft: { rate: 10, burst: 10 },
  comment: { rate: 1, burst: 5 },
  presence: { rate: 20, burst: 20 },
  yjs: { rate: 60, burst: 120 },
  awareness: { rate: 30, burst: 30 },
  control: { rate: 10, burst: 20 },
  room: { rate: 1, burst: 16 }
};

export const LIMIT_CLASS: Record<LiveMessageType, LimitClass> = {
  hello: 'control',
  presence: 'presence',
  draft: 'draft',
  comment: 'comment',
  follow: 'presence',
  yjs: 'yjs',
  'yjs-awareness': 'awareness',
  'yjs-save': 'control',
  'yjs-reload': 'control',
  'yjs-leave': 'control',
  ping: 'control'
};

export function createLimiters(now: () => number = Date.now): Record<LimitClass, TokenBucket> {
  const out = {} as Record<LimitClass, TokenBucket>;
  for (const key of Object.keys(LIVE_LIMITS) as LimitClass[]) {
    out[key] = new TokenBucket(LIVE_LIMITS[key].rate, LIVE_LIMITS[key].burst, now);
  }
  return out;
}

export const LIVE_MAX_PENDING_FRAMES = 256;

export class FrameQueue {
  private tail: Promise<void> = Promise.resolve();

  private pending = 0;

  constructor(
    private readonly max: number = LIVE_MAX_PENDING_FRAMES,
    private readonly onError: (e: unknown) => void = () => {}
  ) {}

  push(task: () => Promise<unknown>): boolean {
    if (this.pending >= this.max) return false;
    this.pending += 1;
    this.tail = this.tail
      .then(task)
      .then(
        () => undefined,
        (e) => this.onError(e)
      )
      .finally(() => {
        this.pending -= 1;
      });
    return true;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
