import type { APIRoute } from 'astro';
import { apiOverviewMarkdown } from '../lib/api-markdown';
import { markdownResponse } from '../lib/markdown';

export const GET: APIRoute = () => markdownResponse(apiOverviewMarkdown());
