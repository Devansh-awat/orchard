import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SECTION_TITLES, SITE, entryLine, sectionOf, sortEntries } from '../lib/llms';

export const GET: APIRoute = async () => {
  const entries = sortEntries(await getCollection('docs')).filter((entry) => entry.id !== '404');

  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const title = SECTION_TITLES[sectionOf(entry)] ?? 'Overview';
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title)!.push(entry);
  }

  const lines = [
    '# Hack Club Orchard',
    '',
    '> Orchard is an open-source, self-hosted platform as a service (PaaS) from Hack Club. One',
    '> command installs it on a Linux server, with no Kubernetes knowledge needed, and it',
    '> deploys apps from a repository or an image, with Postgres, jobs, logs, metrics,',
    '> rollbacks, teams and SSO.',
    '',
    'Every link below returns Markdown. Append `.md` to any documentation URL to get its',
    `Markdown source. \`${SITE}/llms-full.txt\` contains the documentation as one file.`,
    'Each section also has its own index, for example `/deploy/llms.txt`.',
    '',
    '## Start here',
    '',
    `- [Docs home](${SITE}/index.md)`,
    `- [What is Orchard](${SITE}/start/what-is-orchard.md)`,
    `- [Features](${SITE}/start/features.md)`,
    `- [Compare](https://orchard.hackclub.com/compare): how Orchard compares with other self-hosted platforms`,
    `- [Agent setup](${SITE}/agent-setup.md): connect an MCP client to an Orchard instance`,
    `- [Directory](${SITE}/directory.md): everything Orchard does, with links`,
    ''
  ];

  const order = [...new Set(['Get started', 'Overview', ...Object.values(SECTION_TITLES)])];
  const rank = (title: string) => (order.includes(title) ? order.indexOf(title) : order.length);
  const ordered = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  for (const title of ordered) {
    lines.push(`## ${title}`, '');
    for (const entry of groups.get(title)!) lines.push(entryLine(entry));
    lines.push('');
  }

  lines.push('## API', '', `- [API reference](${SITE}/api.md): every endpoint, by tag`, '');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};
