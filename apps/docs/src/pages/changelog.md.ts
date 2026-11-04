import type { APIRoute } from 'astro';
import { markdownResponse } from '../lib/markdown';
import { changelogMarkdown } from '../lib/page-markdown';

export const GET: APIRoute = () => markdownResponse(changelogMarkdown());
