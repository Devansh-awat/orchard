import type { APIRoute } from 'astro';
import { markdownResponse } from '../lib/markdown';
import { homeMarkdown } from '../lib/page-markdown';

export const GET: APIRoute = () => markdownResponse(homeMarkdown());
