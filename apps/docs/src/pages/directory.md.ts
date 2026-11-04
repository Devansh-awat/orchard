import type { APIRoute } from 'astro';
import { markdownResponse } from '../lib/markdown';
import { directoryMarkdown } from '../lib/page-markdown';

export const GET: APIRoute = () => markdownResponse(directoryMarkdown());
