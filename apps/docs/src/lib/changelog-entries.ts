export interface ChangelogEntry {
  date: string;
  type: 'Feature' | 'Fix';
  component: string;
  text: string;
  detail: string;
  href?: string;
}

export const ENTRIES: ChangelogEntry[] = [
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'Install',
    text: 'Set up GitHub from your account settings',
    detail:
      'If an instance has no GitHub App, a superadmin can create one from the GitHub card. Other members see that an admin needs to set it up.',
    href: '/deploy/github/'
  },
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'Install',
    text: 'The installer now guides you through setup',
    detail:
      'The installer asks one question at a time and offers a default for each answer. It shows your answers for review, and checks your DNS records before it installs anything.',
    href: '/start/install/'
  },
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'Install',
    text: 'Resource limits can be turned off',
    detail:
      'Choose limits on or off during setup, or later in Instance admin. Running apps keep their current settings until their next restart.',
    href: '/operate/resource-limits/'
  },
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'Install',
    text: 'Use any S3-compatible storage provider',
    detail:
      'Set up Amazon S3, Cloudflare R2, MinIO, or another S3-compatible provider in the installer, in the dashboard, or with a command. Database backups work without S3 and stay on your server.',
    href: '/operate/storage/'
  },
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'Install',
    text: 'Locked settings now show the command to change them',
    detail:
      'When the dashboard cannot change a setting, it shows the command to run. On a Helm install, it shows the values to edit instead.',
    href: '/operate/configuration/'
  },
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'Teams',
    text: 'Invite people to an instance with no email server',
    detail:
      'If email is not set up, an invitation returns a link that you can share. The person chooses a password or a passkey when they join.',
    href: '/teams/organizations/'
  },
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'CLI',
    text: 'Deploy a public repository with orchard import',
    detail: 'The command works on an instance that has no GitHub App.',
    href: '/deploy/deploy-from-terminal/'
  },
  {
    date: '2026-11-04',
    type: 'Fix',
    component: 'CLI',
    text: 'Orchard reads the port from a base image',
    detail:
      'A Dockerfile with no EXPOSE now uses the port that its base image exposes. The CLI also warns you when a live app returns a gateway error.',
    href: '/operate/troubleshooting/'
  },
  {
    date: '2026-11-04',
    type: 'Fix',
    component: 'Teams',
    text: 'Project caps are checked before a change applies',
    detail:
      'Creating, scaling, or resizing an app over a project cap now returns an error that names the limit.',
    href: '/teams/quotas/'
  },
  {
    date: '2026-11-04',
    type: 'Fix',
    component: 'MCP',
    text: 'Connecting an MCP client requires your approval',
    detail:
      'The consent page shows the client and the address that receives access, and waits for you to select Approve.',
    href: '/mcp/'
  },
  {
    date: '2026-11-04',
    type: 'Feature',
    component: 'Docs',
    text: 'New documentation site',
    detail:
      'Every page has a Markdown version and a prompt that you can copy to an agent. The site also adds a product directory and a page for setting up agents.',
    href: '/agent-setup/'
  },
  {
    date: '2026-11-02',
    type: 'Feature',
    component: 'Databases',
    text: 'Connect to a database from outside the cluster',
    detail: 'Turn on public access, and copy a working connection string from the Connect sheet.',
    href: '/data/databases/'
  },
  {
    date: '2026-11-01',
    type: 'Feature',
    component: 'Databases',
    text: 'Checkpoints, point-in-time restore, and a 30-day trash',
    detail:
      'Restore a database in place or fork it from a checkpoint or a point in time. A deleted database with a backup can be brought back for 30 days.',
    href: '/data/backups/'
  },
  {
    date: '2026-11-01',
    type: 'Feature',
    component: 'Databases',
    text: 'Rehearsed major version upgrades for Postgres',
    detail:
      'Orchard rehearses an upgrade on a copy of the database before it touches your data. The Version card lists the known CVEs for the version that you run.',
    href: '/data/upgrades/'
  },
  {
    date: '2026-11-01',
    type: 'Feature',
    component: 'Apps',
    text: 'Scan images with Harbor or the bundled Trivy scanner',
    detail: 'Image scanning is off until a superadmin turns it on.',
    href: '/operate/image-scanning/'
  },
  {
    date: '2026-11-01',
    type: 'Feature',
    component: 'Apps',
    text: 'See attack attempts and rate-limit an app',
    detail:
      'The Security tab shows attack attempts from the access logs and who sent them. You can rate-limit the app from the same tab.',
    href: '/deploy/security-tab/'
  },
  {
    date: '2026-10-14',
    type: 'Feature',
    component: 'Grafts',
    text: 'Add features to an instance with grafts',
    detail:
      'A graft is an extension that adds pages and API routes to Orchard. Install one with orchardctl or Helm values.',
    href: '/grafts/overview/'
  },
  {
    date: '2026-10-07',
    type: 'Feature',
    component: 'Apps',
    text: 'Pull images from private registries',
    detail: 'Add registry credentials to a project, and its apps can pull private images.',
    href: '/deploy/image/'
  },
  {
    date: '2026-08-25',
    type: 'Feature',
    component: 'Teams',
    text: 'Single sign-on for each organization',
    detail:
      'Add one or more identity providers to an organization, verify its domains with DNS, and give it its own login page.',
    href: '/teams/sso/'
  },
  {
    date: '2026-08-08',
    type: 'Feature',
    component: 'Install',
    text: 'Control where workloads run with node pools',
    detail:
      'Create pools with selectors, tolerations, and affinity, and assign nodes to organizations.',
    href: '/operate/nodes/'
  },
  {
    date: '2026-08-04',
    type: 'Feature',
    component: 'Greenhouse',
    text: 'Run coding agents in Greenhouse',
    detail:
      'Greenhouse runs coding agents on cloud machines that your instance manages, with each session on its own Git worktree.',
    href: '/greenhouse/'
  },
  {
    date: '2026-07-08',
    type: 'Feature',
    component: 'Apps',
    text: 'Send deploy, crash, and backup events to your team',
    detail: 'Add a Discord, Slack, email, or webhook channel, and choose which events to send.',
    href: '/run/notifications/'
  },
  {
    date: '2026-06-16',
    type: 'Feature',
    component: 'Teams',
    text: 'Provision users and groups with SCIM',
    detail: 'Keep Orchard members in sync with your identity provider through SCIM 2.0.',
    href: '/teams/scim/'
  },
  {
    date: '2026-05-15',
    type: 'Feature',
    component: 'Apps',
    text: 'Deploy a Docker Compose file',
    detail: 'Point Orchard at a Compose file in a repository, and each service runs as an app.',
    href: '/run/compose/'
  }
];
