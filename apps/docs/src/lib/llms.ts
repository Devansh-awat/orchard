import type { CollectionEntry } from 'astro:content';

export const SITE = 'https://docs.orchard.my';

type Doc = CollectionEntry<'docs'>;

/** Starlight slugs the index page as "", which would produce a bare trailing slash. */
export function docUrl(entry: Doc): string {
  const slug = entry.id.replace(/\/?index$/, '');
  return slug ? `${SITE}/${slug}/` : `${SITE}/`;
}

/** Raw-markdown URL: the page path without its trailing slash, plus `.md`. */
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
