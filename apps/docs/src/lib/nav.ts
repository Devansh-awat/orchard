import type { IconName } from './icons';

export const SITE_URL = 'https://docs.orchard.my';
export const REPO_URL = 'https://github.com/hackclub/orchard';
export const MCP_URL = 'https://mcp.your-orchard-domain';

export const INSTALL_PROMPT =
  'Install Orchard on my server following https://docs.orchard.my/start/install.md. Ask me before anything that is not reversible.';

export const SETUP_PROMPT =
  'Connect to my Orchard instance over MCP. Follow https://docs.orchard.my/agent-setup.md. Ask me for my Orchard domain first.';

export const topNav = [
  { label: 'Directory', href: '/directory/' },
  { label: 'API', href: '/api/' },
  { label: 'CLI', href: '/cli/' },
  { label: 'Changelog', href: '/changelog/' }
] as const;

export const groupIcons: Record<string, IconName> = {
  CLI: 'terminal',
  Agents: 'bot',
  Deploying: 'rocket',
  Data: 'database',
  'Running things': 'layers',
  Greenhouse: 'sprout',
  Grafts: 'plug',
  'Your account': 'user',
  Teams: 'users',
  'Operating Orchard': 'server',
  'API reference': 'code'
};

export const footerColumns = [
  {
    title: 'Get started',
    links: [
      { label: 'What is Orchard', href: '/start/what-is-orchard/' },
      { label: 'Install', href: '/start/install/' },
      { label: 'First deploy', href: '/start/first-deploy/' },
      { label: 'Concepts', href: '/start/concepts/' }
    ]
  },
  {
    title: 'Tools',
    links: [
      { label: 'CLI', href: '/cli/' },
      { label: 'API', href: '/api/' },
      { label: 'MCP', href: '/mcp/' },
      { label: 'Agent setup', href: '/agent-setup/' }
    ]
  },
  {
    title: 'Resources',
    links: [
      { label: 'Directory', href: '/directory/' },
      { label: 'Changelog', href: '/changelog/' },
      { label: 'Troubleshooting', href: '/operate/troubleshooting/' },
      { label: 'llms.txt', href: '/llms.txt' }
    ]
  },
  {
    title: 'Project',
    links: [
      { label: 'orchard.my', href: 'https://orchard.my' },
      { label: 'GitHub', href: REPO_URL },
      { label: 'Report an issue', href: `${REPO_URL}/issues/new` },
      { label: 'Licenses', href: '/operate/licenses/' }
    ]
  }
];

export function normalizePath(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

export function isHome(pathname: string): boolean {
  return normalizePath(pathname) === '/';
}

export function isLanding(pathname: string): boolean {
  const path = normalizePath(pathname);
  return (
    path === '/' ||
    path === '/agent-setup/' ||
    path === '/directory/' ||
    path === '/changelog/' ||
    path.startsWith('/changelog/')
  );
}

export function markdownPath(pathname: string): string {
  const path = normalizePath(pathname);
  if (path === '/') return '/index.md';
  if (path.startsWith('/changelog/')) return '/changelog.md';
  return `${path.slice(0, -1)}.md`;
}
