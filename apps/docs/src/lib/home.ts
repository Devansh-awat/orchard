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
    heading: 'Deploy a GitHub repository',
    text: 'Orchard detects how to build your repository and gives the app an HTTPS URL. Each push deploys again.',
    command: 'orchard import owner/repo --wait',
    primary: { label: 'Deploy your first app', href: '/start/first-deploy/' },
    related: [
      { label: 'Terminal', href: '/deploy/deploy-from-terminal/' },
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
    text: 'Orchard runs PostgreSQL in your cluster. With backup storage set, each database takes a daily backup and archives its write-ahead log.',
    command: 'orchard db create --name app-db',
    primary: { label: 'Create a database', href: '/data/databases/' },
    related: [
      { label: 'Backups', href: '/data/backups/' },
      { label: 'High availability', href: '/data/high-availability/' },
      { label: 'Read replicas', href: '/data/replicas/' },
      { label: 'Connection pooler', href: '/data/connection-pooler/' }
    ]
  },
  {
    id: 'observe',
    label: 'Observe',
    icon: 'activity',
    heading: 'Read logs and metrics',
    text: 'Read metrics, logs, requests and errors for each app. Set alert rules on any metric.',
    command: 'orchard logs <deploymentId> --follow',
    primary: { label: 'Monitor an app', href: '/run/monitor-an-app/' },
    related: [
      { label: 'Logs', href: '/run/logs/' },
      { label: 'Alert rules', href: '/run/alerts/' },
      { label: 'Notifications', href: '/run/notifications/' },
      { label: 'Status pages', href: '/run/status-pages/' }
    ]
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'bot',
    heading: 'Connect an agent over MCP',
    text: 'Agents deploy apps, manage databases and read logs through the Orchard MCP server. An agent acts as your account.',
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
