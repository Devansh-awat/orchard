import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { SECTION_TITLES, SITE, entryLine, sectionOf, sortEntries } from '../../lib/llms';

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = sortEntries(await getCollection('docs'));
  return Object.entries(SECTION_TITLES).map(([section, title]) => ({
    params: { section },
    props: {
      title,
      lines: entries.filter((entry) => sectionOf(entry) === section).map(entryLine)
    }
  }));
};

export const GET: APIRoute = ({ props }) => {
  const { title, lines } = props as { title: string; lines: string[] };
  const body = [`# Orchard: ${title}`, '', `Full index: ${SITE}/llms.txt`, '', ...lines, ''].join('\n');
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};
