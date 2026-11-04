import type { IconName } from './icons';

export interface DirectoryItem {
  title: string;
  text: string;
  href: string;
  icon: IconName;
  group: string;
}

export const DIRECTORY_TEXT = 'Everything Orchard does, with a link to its documentation.';

export const directoryGroups = [
  'Deploy',
  'Data',
  'Run',
  'Observe',
  'Agents and tools',
  'Greenhouse',
  'Grafts',
  'Teams',
  'Operate'
] as const;

export const directory: DirectoryItem[] = [
  { title: 'GitHub deploys', text: 'Connect a repository and deploy on every push.', href: '/deploy/github/', icon: 'git-branch', group: 'Deploy' },
  { title: 'Other git providers', text: 'Deploy from GitLab, Gitea and other providers.', href: '/deploy/git-providers/', icon: 'git-branch', group: 'Deploy' },
  { title: 'Image deploys', text: 'Run a container image with no build step.', href: '/deploy/image/', icon: 'box', group: 'Deploy' },
  { title: 'Terminal deploys', text: 'Deploy a local directory with orchard up.', href: '/deploy/deploy-from-terminal/', icon: 'terminal', group: 'Deploy' },
  { title: 'Builds', text: 'Build and cache images, and debug failed builds.', href: '/deploy/builds/', icon: 'layers', group: 'Deploy' },
  { title: 'Domains and HTTPS', text: 'Use the generated URL or point your own domain at an app.', href: '/deploy/domains/', icon: 'globe', group: 'Deploy' },
  { title: 'Networking', text: 'Configure ports, internal DNS and public access.', href: '/deploy/networking/', icon: 'network', group: 'Deploy' },
  { title: 'Scaling and resources', text: 'Set replicas, CPU and memory for an app.', href: '/deploy/scaling/', icon: 'scale', group: 'Deploy' },
  { title: 'Resource suggestions', text: 'Set CPU and memory from measured usage.', href: '/deploy/resource-suggestions/', icon: 'sliders', group: 'Deploy' },
  { title: 'Update strategies', text: 'Select how Orchard replaces pods during a deploy.', href: '/deploy/update-strategies/', icon: 'refresh', group: 'Deploy' },
  { title: 'Storage', text: 'Attach volumes that survive restarts and redeploys.', href: '/deploy/storage/', icon: 'hard-drive', group: 'Deploy' },
  { title: 'Rollbacks', text: 'Go back to any earlier build.', href: '/deploy/rollbacks/', icon: 'history', group: 'Deploy' },
  { title: 'Deployment protection', text: 'Put an auth wall in front of a public app.', href: '/deploy/protection/', icon: 'lock', group: 'Deploy' },
  { title: 'App security', text: 'Read findings, scan results and attack attempts for an app.', href: '/deploy/security-tab/', icon: 'shield', group: 'Deploy' },
  { title: 'Connect resources', text: 'Read the connection details of a database or another app.', href: '/deploy/connect-resources/', icon: 'network', group: 'Deploy' },
  { title: 'score.yaml', text: 'Describe ports, variables and databases in your repository.', href: '/deploy/score/', icon: 'file', group: 'Deploy' },

  { title: 'Databases', text: 'Run managed PostgreSQL next to your app.', href: '/data/databases/', icon: 'database', group: 'Data' },
  { title: 'Backups and restore', text: 'Use checkpoints, point-in-time restore, forks and restore tests.', href: '/data/backups/', icon: 'refresh', group: 'Data' },
  { title: 'Read replicas', text: 'Add read-only copies of a database to spread query load.', href: '/data/replicas/', icon: 'layers', group: 'Data' },
  { title: 'High availability', text: 'Add standby instances to a database.', href: '/data/high-availability/', icon: 'server', group: 'Data' },
  { title: 'Connection pooler', text: 'Let apps share a small set of server connections.', href: '/data/connection-pooler/', icon: 'network', group: 'Data' },
  { title: 'Database users', text: 'Create read-only or read-write PostgreSQL users.', href: '/data/users/', icon: 'user', group: 'Data' },
  { title: 'PostgreSQL upgrades', text: 'Upgrade a database to a newer major version.', href: '/data/upgrades/', icon: 'refresh', group: 'Data' },
  { title: 'Database protection', text: 'Turn on deletion protection and weekly restore tests.', href: '/data/protection/', icon: 'lock', group: 'Data' },
  { title: 'PostgreSQL parameters', text: 'Change connection, memory, timeout and logging parameters.', href: '/data/parameters/', icon: 'sliders', group: 'Data' },
  { title: 'Database storage', text: 'Increase the volume size of a database.', href: '/data/storage/', icon: 'hard-drive', group: 'Data' },
  { title: 'Database monitoring', text: 'Read metrics and query performance for a database.', href: '/data/monitoring/', icon: 'activity', group: 'Data' },
  { title: 'PostgreSQL extensions', text: 'Install extensions without a shell.', href: '/data/extensions/', icon: 'plug', group: 'Data' },

  { title: 'Environments and variables', text: 'Set app and shared variables, and separate production.', href: '/run/environments/', icon: 'sliders', group: 'Run' },
  { title: 'Jobs and pipelines', text: 'Run cron schedules and multi-step jobs on the cluster.', href: '/run/jobs/', icon: 'clock', group: 'Run' },
  { title: 'Compose stacks', text: 'Deploy several services from a docker-compose file.', href: '/run/compose/', icon: 'layers', group: 'Run' },
  { title: 'Templates', text: 'Create several resources together in one click.', href: '/run/templates/', icon: 'box', group: 'Run' },
  { title: 'Webhooks', text: 'Trigger a deploy from outside Orchard.', href: '/run/webhooks/', icon: 'webhook', group: 'Run' },
  { title: 'Terraform and OpenTofu', text: 'Manage projects, apps, databases and domains from HCL.', href: '/run/terraform/', icon: 'code', group: 'Run' },
  { title: 'Terminal dashboard', text: 'Manage projects, apps and databases with orchard ui.', href: '/run/terminal-dashboard/', icon: 'terminal', group: 'Run' },
  { title: 'The Grove', text: 'Run a discussion space for your instance.', href: '/run/grove/', icon: 'users', group: 'Run' },

  { title: 'Logs and shell', text: 'Read live logs and crash reports, and open a terminal in a container.', href: '/run/logs/', icon: 'terminal', group: 'Observe' },
  { title: 'Metrics and alerts', text: 'Track CPU and memory, and alert when something is wrong.', href: '/run/observability/', icon: 'activity', group: 'Observe' },
  { title: 'App monitoring', text: 'Read metrics, logs, requests and errors for an app.', href: '/run/monitor-an-app/', icon: 'activity', group: 'Observe' },
  { title: 'Alert rules', text: 'Fire an alert when a metric crosses a threshold.', href: '/run/alerts/', icon: 'bell', group: 'Observe' },
  { title: 'Status pages', text: 'Publish the current state and uptime of your apps.', href: '/run/status-pages/', icon: 'globe', group: 'Observe' },
  { title: 'Notifications', text: 'Send deploy and crash events to Slack, Discord or a webhook.', href: '/run/notifications/', icon: 'bell', group: 'Observe' },
  { title: 'Request data', text: 'Search logs and review requests and attack signals.', href: '/operate/logs/', icon: 'list', group: 'Observe' },
  { title: 'Image scanning', text: 'Choose a vulnerability scanner for the Security tab.', href: '/operate/image-scanning/', icon: 'shield', group: 'Observe' },

  { title: 'Agent setup', text: 'Connect a coding agent to Orchard over MCP.', href: '/agent-setup/', icon: 'bot', group: 'Agents and tools' },
  { title: 'MCP server', text: 'Let an agent deploy, provision and debug as you.', href: '/mcp/', icon: 'plug', group: 'Agents and tools' },
  { title: 'MCP tools', text: 'Review every tool the MCP server exposes.', href: '/reference/mcp-tools/', icon: 'list', group: 'Agents and tools' },
  { title: 'Code mode', text: 'Reach the whole API with the compact MCP or a script.', href: '/agents-code-mode/', icon: 'code', group: 'Agents and tools' },
  { title: 'Docs for agents', text: 'Read these docs as Markdown and llms.txt.', href: '/for-agents/', icon: 'file', group: 'Agents and tools' },
  { title: 'CLI', text: 'Install the orchard CLI and work from a terminal.', href: '/cli/', icon: 'terminal', group: 'Agents and tools' },
  { title: 'CLI reference', text: 'Look up every orchard command and flag.', href: '/reference/cli/', icon: 'book', group: 'Agents and tools' },
  { title: 'API reference', text: 'Look up every API endpoint.', href: '/api/', icon: 'code', group: 'Agents and tools' },

  { title: 'Greenhouse', text: 'Run parallel agent sessions on their own git worktrees.', href: '/greenhouse/', icon: 'sprout', group: 'Greenhouse' },
  { title: 'Machines', text: 'Choose runners and learn what persists on a machine.', href: '/greenhouse/machines/', icon: 'server', group: 'Greenhouse' },
  { title: 'Editors', text: 'Connect VS Code, Cursor, Zed or ssh to a machine.', href: '/greenhouse/editors/', icon: 'code', group: 'Greenhouse' },
  { title: 'Previews and ports', text: 'Open the dev server that a session is running.', href: '/greenhouse/previews/', icon: 'globe', group: 'Greenhouse' },
  { title: 'Setup and run scripts', text: 'Prepare each new worktree and start your app.', href: '/greenhouse/scripts/', icon: 'file', group: 'Greenhouse' },
  { title: 'Machine sharing', text: 'Invite people to a machine as guests.', href: '/greenhouse/sharing/', icon: 'users', group: 'Greenhouse' },
  { title: 'Greenhouse automation', text: 'Control machines with MCP tools, the CLI and the API.', href: '/greenhouse/automation/', icon: 'bot', group: 'Greenhouse' },
  { title: 'Pull requests and checks', text: 'Commit, open a pull request and follow CI from a session.', href: '/greenhouse/pull-requests/', icon: 'git-branch', group: 'Greenhouse' },
  { title: 'Greenhouse integrations', text: 'Start sessions from GitHub, Linear and Slack.', href: '/greenhouse/integrations/', icon: 'plug', group: 'Greenhouse' },

  { title: 'Grafts', text: 'Add features to Orchard with extensions.', href: '/grafts/overview/', icon: 'plug', group: 'Grafts' },
  { title: 'Install grafts', text: 'Add and remove grafts with orchardctl or Helm values.', href: '/grafts/install/', icon: 'box', group: 'Grafts' },
  { title: 'Announcements', text: 'Post instance-wide notices on project and app pages.', href: '/grafts/announcements/', icon: 'bell', group: 'Grafts' },
  { title: 'Build a graft', text: 'Scaffold a graft and run it against a local Orchard.', href: '/grafts/build/quickstart/', icon: 'code', group: 'Grafts' },

  { title: 'Organizations and roles', text: 'Control who can do what, and at which level.', href: '/teams/organizations/', icon: 'users', group: 'Teams' },
  { title: 'Projects', text: 'Add members, transfer ownership or move a project.', href: '/teams/projects/', icon: 'box', group: 'Teams' },
  { title: 'SSO', text: 'Configure SAML and OIDC sign-in per organization.', href: '/teams/sso/', icon: 'key', group: 'Teams' },
  { title: 'SCIM provisioning', text: 'Create and deactivate accounts from your identity provider.', href: '/teams/scim/', icon: 'users', group: 'Teams' },
  { title: 'Audit logs', text: 'Review a record of who did what.', href: '/teams/audit-logs/', icon: 'list', group: 'Teams' },
  { title: 'Quotas and usage', text: 'Set organization caps and per-member allowances.', href: '/teams/quotas/', icon: 'sliders', group: 'Teams' },
  { title: 'Usage review', text: 'Read resource usage by project, member and workload.', href: '/teams/usage/', icon: 'activity', group: 'Teams' },
  { title: 'API tokens', text: 'Create credentials for scripts and CI.', href: '/account/tokens/', icon: 'key', group: 'Teams' },
  { title: 'SSH identities', text: 'Add the public keys that reach your Greenhouse machines.', href: '/account/ssh-identities/', icon: 'key', group: 'Teams' },

  { title: 'Install', text: 'Install on a Linux server or with the Helm chart.', href: '/start/install/', icon: 'rocket', group: 'Operate' },
  { title: 'Architecture', text: 'See what runs where.', href: '/operate/architecture/', icon: 'network', group: 'Operate' },
  { title: 'Configuration', text: 'Find where instance settings live and change them.', href: '/operate/configuration/', icon: 'sliders', group: 'Operate' },
  { title: 'Instance admin', text: 'Configure the instance and manage users and organizations.', href: '/operate/instance-admin/', icon: 'sliders', group: 'Operate' },
  { title: 'Environment variables', text: 'Look up every variable the server reads.', href: '/reference/configuration/', icon: 'list', group: 'Operate' },
  { title: 'Host commands', text: 'Use orchardctl on an Orchard host.', href: '/operate/host-commands/', icon: 'terminal', group: 'Operate' },
  { title: 'Nodes and pools', text: 'Decide what runs where in the cluster.', href: '/operate/nodes/', icon: 'server', group: 'Operate' },
  { title: 'Node pools', text: 'Create pools and set taints and organization assignments.', href: '/operate/node-pools/', icon: 'layers', group: 'Operate' },
  { title: 'Upgrades', text: 'Move to a new version of Orchard.', href: '/operate/upgrades/', icon: 'refresh', group: 'Operate' },
  { title: 'Going to production', text: 'Prepare a trial instance for real work.', href: '/operate/production/', icon: 'rocket', group: 'Operate' },
  { title: 'Wildcard certificates', text: 'Issue one certificate for every generated app URL.', href: '/operate/wildcard-certificates/', icon: 'lock', group: 'Operate' },
  { title: 'Bot protection', text: 'Add a Cloudflare Turnstile challenge to sign-in pages.', href: '/operate/bot-protection/', icon: 'shield', group: 'Operate' },
  { title: 'Database dumps', text: 'Run pg_dump on a schedule and upload to object storage.', href: '/operate/database-dumps/', icon: 'database', group: 'Operate' },
  { title: 'Usage reports', text: 'Review what an instance sends, and turn reports on or off.', href: '/operate/telemetry/', icon: 'list', group: 'Operate' },
  { title: 'Security and isolation', text: 'See what Orchard isolates by default and what it does not.', href: '/operate/security/', icon: 'shield', group: 'Operate' },
  { title: 'Troubleshooting', text: 'Look up common failures and what they mean.', href: '/operate/troubleshooting/', icon: 'activity', group: 'Operate' }
];
