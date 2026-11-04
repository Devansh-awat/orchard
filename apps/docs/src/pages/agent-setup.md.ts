import type { APIRoute } from 'astro';
import { markdownResponse } from '../lib/markdown';
import { agentSetupMarkdown } from '../lib/page-markdown';

export const GET: APIRoute = () => markdownResponse(agentSetupMarkdown());
