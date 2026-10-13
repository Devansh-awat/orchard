import { BadRequestException } from '@nestjs/common';

export const REPO_ICON_LUCIDE = [
  'rocket',
  'globe',
  'server',
  'database',
  'package',
  'terminal',
  'code',
  'book',
  'leaf',
  'sprout',
  'flame',
  'zap',
  'cpu',
  'cloud',
  'shield',
  'palette',
  'gamepad-2',
  'bot',
  'music',
  'camera'
] as const;

export const REPO_ICON_GITHUB = 'github';
export const REPO_ICON_MAX_BYTES = 16;

const LUCIDE = new Set<string>(REPO_ICON_LUCIDE);
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const FLAG_RE = /^\p{Regional_Indicator}{2}$/u;
const FORBIDDEN_RE = /[\p{Cc}\p{Zl}\p{Zp}\s]/u;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function isRepoEmoji(value: string): boolean {
  if (!value || Buffer.byteLength(value, 'utf8') > REPO_ICON_MAX_BYTES) return false;
  if (FORBIDDEN_RE.test(value)) return false;
  const parts = [...graphemes.segment(value)];
  if (parts.length !== 1) return false;
  return PICTOGRAPHIC_RE.test(value) || FLAG_RE.test(value);
}

export function isRepoIcon(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === REPO_ICON_GITHUB) return true;
  if (value.startsWith('lucide:')) return LUCIDE.has(value.slice('lucide:'.length));
  return isRepoEmoji(value);
}

export function normalizeRepoIcon(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('icon must be a string or null');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isRepoIcon(trimmed)) {
    throw new BadRequestException(
      `icon must be one emoji, "${REPO_ICON_GITHUB}", or lucide:<name> with one of: ${REPO_ICON_LUCIDE.join(', ')}`
    );
  }
  return trimmed;
}

export function storedRepoIcon(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return isRepoIcon(trimmed) ? trimmed : null;
}
