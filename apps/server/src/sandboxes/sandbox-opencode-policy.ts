import { randomInt } from 'crypto';
import type { SandboxMinRole } from './sandbox-access.service';

const VIEWER_READS: RegExp[] = [
  /^\/event$/,
  /^\/global\/event$/,
  /^\/session$/,
  /^\/session\/status$/,
  /^\/session\/[^/]+$/,
  /^\/session\/[^/]+\/(message|children|todo|diff)$/,
  /^\/session\/[^/]+\/message\/[^/]+$/,
  /^\/agent$/,
  /^\/command$/,
  /^\/project$/,
  /^\/project\/current$/,
  /^\/vcs$/,
  /^\/lsp$/,
  /^\/formatter$/,
  /^\/path$/
];

const OWNER_ONLY: RegExp[] = [
  /^\/config(\/|$)/,
  /^\/auth(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/pty(\/|$)/,
  /^\/provider\/[^/]+\/oauth(\/|$)/,
  /^\/session\/[^/]+\/share$/,
  /^\/instance(\/|$)/,
  /^\/global(\/|$)/,
  /^\/tui(\/|$)/,
  /^\/experimental(\/|$)/,
  /^\/project\/[^/]+$/,
  /^\/doc$/
];

const PROMPT_RE = /^\/session\/(ses_[A-Za-z0-9]{1,60})\/(prompt_async|message|command)$/;

export const OPENCODE_MESSAGE_ID_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const SAFE_RAW_PATH = /^[A-Za-z0-9_.~/%-]*$/;

const SAFE_CONTENT_TYPES = new Set(['application/json', 'text/event-stream', 'text/plain']);

export const OPENCODE_RESPONSE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin'
};

export function opencodeContentType(raw: string | string[] | undefined): string {
  if (raw === undefined) return 'application/json';
  if (Array.isArray(raw)) return 'application/octet-stream';
  const base = raw.split(';')[0].trim().toLowerCase();
  return SAFE_CONTENT_TYPES.has(base) ? base : 'application/octet-stream';
}

export function normalizeOpencodePath(suffix: string): string | null {
  const raw = suffix.split('?')[0] ?? '';
  if (!SAFE_RAW_PATH.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/[\\\0]/.test(decoded) || /%/.test(decoded)) return null;
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return `/${segments.join('/')}`.toLowerCase();
}

export function opencodeSuffixOf(originalUrl: string): string {
  const marker = '/opencode/';
  const at = originalUrl.indexOf(marker);
  if (at < 0) return '';
  return originalUrl.slice(at + marker.length);
}

export function opencodeMinRole(method: string, suffix: string): SandboxMinRole {
  const path = normalizeOpencodePath(suffix);
  if (path === null) return 'owner';
  const verb = (method || '').toUpperCase();
  if (OWNER_ONLY.some((re) => re.test(path))) {
    if ((verb === 'GET' || verb === 'HEAD') && /^\/config\/providers$/.test(path)) {
      return 'collaborator';
    }
    if ((verb === 'GET' || verb === 'HEAD') && /^\/(global\/event|doc)$/.test(path))
      return 'viewer';
    return 'owner';
  }
  if (verb === 'GET' || verb === 'HEAD') {
    return VIEWER_READS.some((re) => re.test(path)) ? 'viewer' : 'collaborator';
  }
  return 'collaborator';
}

export interface OpencodePromptTarget {
  chatId: string;
  kind: 'prompt_async' | 'message' | 'command';
}

export function opencodePromptTarget(method: string, suffix: string): OpencodePromptTarget | null {
  if ((method || '').toUpperCase() !== 'POST') return null;
  const raw = suffix.split('?')[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const match = `/${decoded.replace(/^\/+/, '').replace(/\/+$/, '')}`.match(PROMPT_RE);
  if (!match) return null;
  return { chatId: match[1], kind: match[2] as OpencodePromptTarget['kind'] };
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let lastTimestamp = 0;
let counter = 0;

export function newOpencodeMessageId(now: number = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  }
  counter += 1;
  const value = BigInt(now) * BigInt(0x1000) + BigInt(counter);
  let hex = '';
  for (let i = 0; i < 6; i++) {
    const byte = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff));
    hex += byte.toString(16).padStart(2, '0');
  }
  let random = '';
  for (let i = 0; i < 14; i++) random += BASE62[randomInt(0, 62)];
  return `msg_${hex}${random}`;
}
