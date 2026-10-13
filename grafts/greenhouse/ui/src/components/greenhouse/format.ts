import type { SandboxRunnerId } from '../../lib/types/sandbox';
import { REMOTE_COLOR_VARS, remoteColorVar } from '../sandbox/editor/collab';

export function presenceColorVar(user: { id: string; color?: unknown }): string {
  const color = user.color;
  if (typeof color === 'string' && color.startsWith('--')) return color;
  if (typeof color === 'number' && Number.isInteger(color)) {
    const n = REMOTE_COLOR_VARS.length;
    return REMOTE_COLOR_VARS[((color % n) + n) % n];
  }
  return remoteColorVar(user.id);
}

const RUNNER_LABELS: Record<string, string> = {
  kubernetes: 'Kubernetes',
  vercel: 'Vercel'
};

export function runnerLabel(runner: SandboxRunnerId | string | null | undefined): string {
  if (!runner) return 'Kubernetes';
  return RUNNER_LABELS[runner] ?? runner.charAt(0).toUpperCase() + runner.slice(1);
}

const REPO_HUES = [
  '--hue-blue',
  '--hue-violet',
  '--hue-emerald',
  '--hue-amber',
  '--hue-pink',
  '--hue-green',
  '--hue-red',
  '--hue-slate'
];

export function repoHue(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 33 + name.charCodeAt(i)) | 0;
  return REPO_HUES[Math.abs(hash) % REPO_HUES.length];
}

export function repoInitial(name: string): string {
  const clean = name.replace(/^[^a-zA-Z0-9]+/, '');
  return (clean.charAt(0) || '?').toUpperCase();
}

export function ago(value: string | number | null | undefined): string {
  if (!value) return '';
  const then = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
}

export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl ';
}

export function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
