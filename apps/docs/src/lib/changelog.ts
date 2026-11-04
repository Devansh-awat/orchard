import { ENTRIES } from './changelog-entries';

export type ChangeType = 'Feature' | 'Fix';

export interface Change {
  id: string;
  date: string;
  type: ChangeType;
  component: string;
  componentSlug: string;
  text: string;
  detail?: string;
  version?: string;
  url?: string;
}

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

let memo: Change[] | undefined;

export function getChanges(): Change[] {
  memo ??= ENTRIES.map(({ href, ...entry }) => ({
    ...entry,
    id: `${entry.date}-${slugify(entry.text)}`,
    componentSlug: slugify(entry.component),
    url: href
  })).sort(
    (a, b) =>
      b.date.localeCompare(a.date) || (a.type === b.type ? 0 : a.type === 'Feature' ? -1 : 1)
  );
  return memo;
}

export const PAGE_SIZE = 40;

export function getComponents(): Array<{ label: string; slug: string; count: number }> {
  const counts = new Map<string, { label: string; slug: string; count: number }>();
  for (const change of getChanges()) {
    const found = counts.get(change.componentSlug);
    if (found) found.count += 1;
    else
      counts.set(change.componentSlug, {
        label: change.component,
        slug: change.componentSlug,
        count: 1
      });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function changeHref(change: Change): string {
  const index = getChanges().indexOf(change);
  const page = Math.floor(index / PAGE_SIZE) + 1;
  return `${page === 1 ? '/changelog/' : `/changelog/page/${page}/`}#${change.id}`;
}

export function getFeatured(count: number): Change[] {
  return getChanges()
    .filter((change) => change.type === 'Feature')
    .slice(0, count);
}

export function formatDate(date: string, withYear = true, pad = true): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: pad ? '2-digit' : 'numeric',
    timeZone: 'UTC',
    ...(withYear ? { year: 'numeric' } : {})
  });
}

export function groupByDate(changes: Change[]): Array<{ date: string; changes: Change[] }> {
  const groups: Array<{ date: string; changes: Change[] }> = [];
  for (const change of changes) {
    const last = groups.at(-1);
    if (last?.date === change.date) last.changes.push(change);
    else groups.push({ date: change.date, changes: [change] });
  }
  return groups;
}
