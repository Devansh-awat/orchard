import type { IconName } from './icons';
import { MCP_URL } from './nav';

export interface HomeTab {
  id: 'deploy' | 'databases' | 'observe' | 'agents';
  label: string;
  icon: IconName;
  heading: string;
  text: string;
  command: string;
  primary: { label: string; href: string };
  related: Array<{ label: string; href: string }>;
}

export const HERO_TEXT = 'Install Orchard on a Linux server or a Kubernetes cluster, then deploy your apps.';

export const TABS_HEADING = 'Run apps and databases on your cluster';

export const homeTabs: HomeTab[] = [
  {
    id: 'deploy',
    label: 'Deploy',
    icon: 'rocket',
    heading: 'Deploy from a directory or a repository',
    text: 'Orchard builds your app on your cluster and gives it an HTTPS URL. Every push to a connected repository deploys again.',
    command: 'orchard up',
    primary: { label: 'Deploy your first app', href: '/start/first-deploy/' },
    related: [
      { label: 'GitHub', href: '/deploy/github/' },
      { label: 'Images', href: '/deploy/image/' },
      { label: 'Domains', href: '/deploy/domains/' },
      { label: 'Scaling', href: '/deploy/scaling/' },
      { label: 'Rollbacks', href: '/deploy/rollbacks/' }
    ]
  },
  {
    id: 'databases',
    label: 'Databases',
    icon: 'database',
    heading: 'Create a PostgreSQL database',
    text: 'Orchard runs PostgreSQL in your cluster. With a backup bucket set, each database archives its write-ahead log and takes a nightly backup.',
    command: 'orchard db create --name app-db',
    primary: { label: 'Create a database', href: '/data/databases/' },
    related: [
      { label: 'Backups', href: '/data/backups/' },
      { label: 'Read replicas', href: '/data/replicas/' },
      { label: 'Extensions', href: '/data/extensions/' }
    ]
  },
  {
    id: 'observe',
    label: 'Observe',
    icon: 'activity',
    heading: 'Read logs and metrics',
    text: 'Follow logs, read crash reports and set alerts on CPU and memory for each app.',
    command: 'orchard logs <deploymentId> --follow',
    primary: { label: 'Read logs', href: '/run/logs/' },
    related: [
      { label: 'Metrics and alerts', href: '/run/observability/' },
      { label: 'Notifications', href: '/run/notifications/' },
      { label: 'Request data', href: '/operate/logs/' }
    ]
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'bot',
    heading: 'Connect an agent over MCP',
    text: 'Agents deploy apps, read logs and manage databases through the Orchard MCP server. An agent acts as the user who connected it.',
    command: `claude mcp add --transport http orchard ${MCP_URL}/`,
    primary: { label: 'Set up your agent', href: '/agent-setup/' },
    related: [
      { label: 'MCP', href: '/mcp/' },
      { label: 'MCP tools', href: '/reference/mcp-tools/' },
      { label: 'Code mode', href: '/agents-code-mode/' },
      { label: 'Docs for agents', href: '/for-agents/' }
    ]
  }
];

export const AGENT_PANEL = {
  heading: 'Build with your agent',
  text: 'Paste this prompt into your coding agent to install Orchard:',
  sideHeading: 'Connect your agent to Orchard',
  sideLink: 'Agent setup'
};

export const WHATS_NEW = {
  heading: "What's new",
  text: 'The latest features and fixes in Orchard.',
  link: 'View changelog'
};
