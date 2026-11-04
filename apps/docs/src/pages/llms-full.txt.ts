import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { entryMarkdown, sortEntries } from '../lib/llms';
import { agentSetupMarkdown } from '../lib/page-markdown';

export const GET: APIRoute = async () => {
  const entries = sortEntries(await getCollection('docs')).filter((entry) => entry.id !== '404');

  const parts = [
    '# Orchard documentation',
    '',
    'Orchard is a self-hosted platform. It installs on a Linux server or a Kubernetes',
    'cluster and deploys apps from a repository or an image.',
    '',
    '---',
    '',
    agentSetupMarkdown(),
    '---',
    ''
  ];

  for (const entry of entries) {
    parts.push(entryMarkdown(entry), '---', '');
  }

  return new Response(parts.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};
