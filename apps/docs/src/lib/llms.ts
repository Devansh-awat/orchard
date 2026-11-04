import type { CollectionEntry } from 'astro:content';
import { toPlainMarkdown } from './markdown';

export const SITE = 'https://docs.orchard.my';

type Doc = CollectionEntry<'docs'>;

export const SECTION_TITLES: Record<string, string> = {
  start: 'Get started',
  deploy: 'Apps',
  data: 'Databases',
  run: 'Apps',
  greenhouse: 'Greenhouse',
  grafts: 'Grafts',
  account: 'Your account',
  teams: 'Teams',
  operate: 'Self-hosting',
  reference: 'Reference'
};

export function docUrl(entry: Doc): string {
  const slug = entry.id.replace(/\/?index$/, '');
  return slug ? `${SITE}/${slug}/` : `${SITE}/`;
}

export function mdUrl(entry: Doc): string {
  const slug = entry.id.replace(/\/?index$/, '');
  return slug ? `${SITE}/${slug}.md` : `${SITE}/index.md`;
}

export function plainTitle(entry: Doc): string {
  return entry.data.title;
}

export function sortEntries(entries: Doc[]): Doc[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

export function sectionOf(entry: Doc): string {
  return entry.id.includes('/')
    ? entry.id.split('/')[0]
    : entry.id === 'greenhouse'
      ? 'greenhouse'
      : 'overview';
}

export function entryLine(entry: Doc): string {
  const description = entry.data.description ? `: ${entry.data.description}` : '';
  return `- [${plainTitle(entry)}](${mdUrl(entry)})${description}`;
}

export function entryMarkdown(entry: Doc): string {
  const parts = [`# ${plainTitle(entry)}`, ''];
  if (entry.data.description) parts.push(`> ${entry.data.description}`, '');
  parts.push(`Source: ${docUrl(entry)}`, '', toPlainMarkdown(entry.body), '');
  return parts.join('\n');
}
