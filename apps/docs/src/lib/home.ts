import type { IconName } from './icons';

export const HERO_TEXT =
  'Install Orchard on a Linux server or a Kubernetes cluster, then deploy your apps.';

export interface HomeStart {
  title: string;
  text: string;
  href: string;
  icon: IconName;
}

export const homeStarts: HomeStart[] = [
  {
    title: 'Install Orchard',
    text: 'Run the installer on a Linux server, or use the Helm chart on your cluster.',
    href: '/start/install/',
    icon: 'server'
  },
  {
    title: 'Deploy your first app',
    text: 'Connect a repository. Orchard builds it and gives it an HTTPS URL.',
    href: '/start/first-deploy/',
    icon: 'rocket'
  },
  {
    title: 'Create a database',
    text: 'Run Postgres next to your app, with backups and point-in-time restore.',
    href: '/data/databases/',
    icon: 'database'
  },
  {
    title: 'Connect an agent',
    text: 'Let a coding agent deploy apps and read logs through MCP.',
    href: '/agent-setup/',
    icon: 'bot'
  }
];

export interface HomeSection {
  title: string;
  icon: IconName;
  links: Array<{ label: string; href: string }>;
}

export const homeSections: HomeSection[] = [
  {
    title: 'Apps',
    icon: 'rocket',
    links: [
      { label: 'Deploy from GitHub', href: '/deploy/github/' },
      { label: 'Domains and HTTPS', href: '/deploy/domains/' },
      { label: 'Variables and environments', href: '/run/environments/' },
      { label: 'Monitor an app', href: '/run/monitor-an-app/' }
    ]
  },
  {
    title: 'Databases',
    icon: 'database',
    links: [
      { label: 'Create a database', href: '/data/databases/' },
      { label: 'Backups and restore', href: '/data/backups/' },
      { label: 'High availability', href: '/data/high-availability/' },
      { label: 'Upgrade Postgres', href: '/data/upgrades/' }
    ]
  },
  {
    title: 'Self-hosting',
    icon: 'server',
    links: [
      { label: 'Finish setup', href: '/operate/finishing-setup/' },
      { label: 'Add S3 storage', href: '/operate/storage/' },
      { label: 'Host commands', href: '/operate/host-commands/' },
      { label: 'Troubleshooting', href: '/operate/troubleshooting/' }
    ]
  },
  {
    title: 'Account and teams',
    icon: 'users',
    links: [
      { label: 'Organizations and roles', href: '/teams/organizations/' },
      { label: 'SSO', href: '/teams/sso/' },
      { label: 'API tokens', href: '/account/tokens/' },
      { label: 'Quotas', href: '/teams/quotas/' }
    ]
  },
  {
    title: 'CLI',
    icon: 'terminal',
    links: [
      { label: 'Overview', href: '/cli/' },
      { label: 'Command reference', href: '/reference/cli/' },
      { label: 'Terminal dashboard', href: '/run/terminal-dashboard/' },
      { label: 'Terraform and OpenTofu', href: '/run/terraform/' }
    ]
  },
  {
    title: 'Agents and MCP',
    icon: 'bot',
    links: [
      { label: 'Agent setup', href: '/agent-setup/' },
      { label: 'MCP', href: '/mcp/' },
      { label: 'MCP tools', href: '/reference/mcp-tools/' },
      { label: 'Docs for agents', href: '/for-agents/' }
    ]
  },
  {
    title: 'Greenhouse',
    icon: 'sprout',
    links: [
      { label: 'Overview', href: '/greenhouse/' },
      { label: 'Get started', href: '/greenhouse/getting-started/' },
      { label: 'The workspace', href: '/greenhouse/workspace/' },
      { label: 'Pull requests and checks', href: '/greenhouse/pull-requests/' }
    ]
  },
  {
    title: 'Grafts',
    icon: 'plug',
    links: [
      { label: 'Overview', href: '/grafts/overview/' },
      { label: 'Install grafts', href: '/grafts/install/' },
      { label: 'Build a graft', href: '/grafts/build/quickstart/' },
      { label: 'Graft API versions', href: '/reference/graft-api/' }
    ]
  }
];

export const AGENT_PANEL = {
  heading: 'Build with your agent',
  text: 'Paste this prompt into your coding agent to install Orchard:',
  sideHeading: 'Connect your agent to Orchard',
  sideLink: 'Agent setup'
};
