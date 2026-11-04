import type { APIRoute, GetStaticPaths } from 'astro';
import {
  apiOperationMarkdown,
  apiOperations,
  apiTagMarkdown,
  apiTags,
  tagSlug
} from '../../lib/api-markdown';
import { markdownResponse } from '../../lib/markdown';

export const getStaticPaths: GetStaticPaths = () => [
  ...apiOperations().map((operation) => ({
    params: { slug: operation.slug },
    props: { body: apiOperationMarkdown(operation) }
  })),
  ...apiTags().map((tag) => ({
    params: { slug: `operations/tags/${tagSlug(tag)}` },
    props: { body: apiTagMarkdown(tag) }
  }))
];

export const GET: APIRoute = ({ props }) => markdownResponse((props as { body: string }).body);
