import { clock } from './clock.svelte';

export function formatRelativeTime(date: Date): string {
  const diffMs = clock.now - date.getTime();
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 5) return 'just now';
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ${diffM % 60}m ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}
