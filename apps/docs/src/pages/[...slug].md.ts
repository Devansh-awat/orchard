import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { docUrl, plainTitle } from '../lib/llms';

/**
 * Raw markdown for any page: append `.md` to a docs URL. This is what the
 * "Copy as Markdown" button fetches, and what llms.txt links to, so an agent
 * reads the source rather than scraping rendered HTML.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection('docs');
  return entries.map((entry) => ({
    // The root page has an empty slug, which would emit a hidden ".md" file.
    params: { slug: entry.id.replace(/\/?index$/, '') || 'index' },
    props: { entry }
  }));
};

export const GET: APIRoute = ({ props }) => {
  const entry = (props as any).entry;
  const parts = [`# ${plainTitle(entry)}`, ''];
  if (entry.data.description) parts.push(`> ${entry.data.description}`, '');
  parts.push(`Source: ${docUrl(entry)}`, '', entry.body?.trim() ?? '', '');

  return new Response(parts.join('\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
  });
};
