import type { HostApi } from '@orchardlabs/graft-sdk/client';
import { statusMeta, type StatusMeta } from '@orchardlabs/graft-ui';

export interface GroveCategory {
  id: string;
  slug: string;
  name: string;
  emoji: string;
  description: string | null;
  threadCount: number;
}

export interface GroveAuthor {
  id: string;
  username: string;
  imageUrl: string | null;
}

export interface GroveThread {
  id: string;
  number: number;
  title: string;
  snippet: string;
  status: string;
  priority: string;
  scope: string;
  images: string[];
  pinned: boolean;
  locked: boolean;
  createdAt: string;
  lastActivityAt: string;
  author: GroveAuthor;
  category: { slug: string; name: string; emoji: string };
  replyCount: number;
  votes: number;
  myVote: boolean;
}

export interface GroveReply {
  id: string;
  body: string;
  images: string[];
  createdAt: string;
  author: GroveAuthor;
}

export const GROVE_STATUSES = [
  'open',
  'acknowledged',
  'will-fix',
  'in-progress',
  'fixed',
  'wont-fix'
] as const;

export const GROVE_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export const GROVE_SCOPES = [
  { value: 'platform', label: 'Main platform' },
  { value: 'cli', label: 'CLI' },
  { value: 'mcp', label: 'MCP' },
  { value: 'other', label: 'Other' }
] as const;

export function scopeLabel(scope: string): string {
  return GROVE_SCOPES.find((s) => s.value === scope)?.label ?? scope;
}

export function groveStatus(status: string): StatusMeta {
  switch (status) {
    case 'acknowledged':
      return statusMeta('neutral', 'Acknowledged');
    case 'will-fix':
      return statusMeta('warning', 'Will fix');
    case 'in-progress':
      return statusMeta('progress', 'In progress', true);
    case 'fixed':
      return statusMeta('success', 'Fixed');
    case 'wont-fix':
      return statusMeta('error', "Won't fix");
    default:
      return statusMeta('info', 'Open');
  }
}

export function grovePriority(priority: string): StatusMeta | null {
  switch (priority) {
    case 'low':
      return statusMeta('neutral', 'Low');
    case 'medium':
      return statusMeta('info', 'Medium');
    case 'high':
      return statusMeta('warning', 'High');
    case 'urgent':
      return statusMeta('error', 'Urgent');
    default:
      return null;
  }
}

export async function failure(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return data?.message || fallback;
}

export function toastError(host: HostApi, title: string, description: string) {
  host.toast(title, 'error', { description });
}

export async function uploadGroveImage(host: HostApi, file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await host.fetch('/uploads', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await failure(res, 'Upload failed'));
  const data = await res.json();
  return data.url;
}

export function timeAgo(d?: string): string {
  if (!d) return '';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  if (dy < 30) return `${dy}d ago`;
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const HUES = [352, 335, 24, 38, 88, 130, 288, 220];

export function swatch(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = HUES[hash % HUES.length];
  let bits = hash || 1;
  const next = () => {
    bits = (bits * 1103515245 + 12345) >>> 0;
    return bits;
  };
  const ripe = `hsl(${hue} 62% 50%)`;
  const shade = `hsl(${hue} 58% 37%)`;
  let rects = '';
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 7; row++) {
      const edge = row === 0 || row === 6;
      if (next() % 100 >= (edge ? 30 : 52)) continue;
      const fill = next() % 100 < 30 ? shade : ripe;
      rects += `<rect x='${col}' y='${row}' width='1' height='1' fill='${fill}'/>`;
      if (col < 3) rects += `<rect x='${6 - col}' y='${row}' width='1' height='1' fill='${fill}'/>`;
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 7 7' shape-rendering='crispEdges'><rect width='7' height='7' fill='hsl(${hue} 48% 93%)'/>${rects}</svg>`;
  return `background-image: url("data:image/svg+xml,${encodeURIComponent(svg)}"); background-size: 100% 100%`;
}
