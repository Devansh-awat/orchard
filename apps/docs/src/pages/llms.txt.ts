import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SECTION_TITLES, SITE, entryLine, sectionOf, sortEntries } from '../lib/llms';

export const GET: APIRoute = async () => {
  const entries = sortEntries(await getCollection('docs')).filter((entry) => entry.id !== '404');

  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const section = sectionOf(entry);
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(entry);
  }

  const lines = [
    '# Orchard',
    '',
    '> Orchard is a self-hosted platform. It installs on a Linux server or a Kubernetes',
    '> cluster and deploys apps from a repository or an image, with PostgreSQL, jobs,',
    '> logs, metrics, rollbacks, teams and SSO.',
    '',
    'Every link below returns Markdown. Append `.md` to any documentation URL to get its',
    `Markdown source. \`${SITE}/llms-full.txt\` contains the documentation as one file.`,
    'Each section also has its own index, for example `/deploy/llms.txt`.',
    '',
    '## Start here',
    '',
    `- [Docs home](${SITE}/index.md)`,
    `- [Agent setup](${SITE}/agent-setup.md): connect an MCP client to an Orchard instance`,
    `- [Directory](${SITE}/directory.md): everything Orchard does, with links`,
    `- [Changelog](${SITE}/changelog.md): features and fixes by date`,
    ''
  ];

  const ordered = [...groups.keys()].sort((a, b) => {
    if (a === 'overview') return -1;
    if (b === 'overview') return 1;
    return a.localeCompare(b);
  });

  for (const section of ordered) {
    lines.push(`## ${SECTION_TITLES[section] ?? 'Overview'}`, '');
    for (const entry of groups.get(section)!) lines.push(entryLine(entry));
    lines.push('');
  }

  lines.push('## API', '', `- [API reference](${SITE}/api.md): every endpoint, by tag`, '');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};
