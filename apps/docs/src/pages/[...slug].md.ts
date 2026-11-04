import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { entryMarkdown } from '../lib/llms';
import { markdownResponse } from '../lib/markdown';

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection('docs');
  return entries
    .filter((entry) => entry.id !== '404')
    .map((entry) => ({
      params: { slug: entry.id.replace(/\/?index$/, '') || 'index' },
      props: { entry }
    }));
};

export const GET: APIRoute = ({ props }) => markdownResponse(entryMarkdown((props as any).entry));
