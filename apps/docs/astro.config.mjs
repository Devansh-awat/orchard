import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';

export default defineConfig({
  site: 'https://docs.orchard.my',
  // The landing page is the front door; docs open straight into the docs.
  redirects: {
    '/': '/start/what-is-orchard/',
    '/run/sandboxes': '/greenhouse/'
  },
  server: { port: 5174, host: true },
  integrations: [
    starlight({
      title: 'Orchard',
      description:
        'Orchard runs on your own Kubernetes cluster and turns a GitHub repo into a running app.',
      favicon: '/favicon/favicon.ico',
      customCss: ['./src/styles/orchard.css'],
      components: {
        PageTitle: './src/overrides/PageTitle.astro',
        SiteTitle: './src/overrides/SiteTitle.astro'
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/hackclub/orchard'
        }
      ],
      editLink: {
        baseUrl: 'https://github.com/hackclub/orchard/edit/main/apps/docs/'
      },
      plugins: [
        starlightOpenAPI([
          {
            base: 'api',
            label: 'API reference',
            schema: './openapi.generated.json'
          }
        ])
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What is Orchard', slug: 'start/what-is-orchard' },
            { label: 'Install', slug: 'start/install' },
            { label: 'First deploy', slug: 'start/first-deploy' },
            { label: 'Concepts', slug: 'start/concepts' }
          ]
        },
        {
          label: 'Deploying',
          items: [
            { label: 'From GitHub', slug: 'deploy/github' },
            { label: 'From GitLab, Gitea and others', slug: 'deploy/git-providers' },
            { label: 'From an image', slug: 'deploy/image' },
            { label: 'From your terminal', slug: 'deploy/deploy-from-terminal' },
            { label: 'Builds', slug: 'deploy/builds' },
            { label: 'Domains and HTTPS', slug: 'deploy/domains' },
            { label: 'Networking', slug: 'deploy/networking' },
            { label: 'Scaling and resources', slug: 'deploy/scaling' },
            { label: 'Resource suggestions', slug: 'deploy/resource-suggestions' },
            { label: 'Storage', slug: 'deploy/storage' },
            { label: 'Update strategies', slug: 'deploy/update-strategies' },
            { label: 'Rollbacks', slug: 'deploy/rollbacks' },
            { label: 'Protection', slug: 'deploy/protection' },
            { label: 'App security', slug: 'deploy/security-tab' },
            { label: 'Connect resources', slug: 'deploy/connect-resources' },
            { label: 'score.yaml', slug: 'deploy/score' }
          ]
        },
        {
          label: 'Data',
          items: [
            { label: 'Databases', slug: 'data/databases' },
            { label: 'Backups and restore', slug: 'data/backups' },
            { label: 'Read replicas', slug: 'data/replicas' },
            { label: 'High availability', slug: 'data/high-availability' },
            { label: 'Connection pooler', slug: 'data/connection-pooler' },
            { label: 'Database users', slug: 'data/users' },
            { label: 'Upgrade PostgreSQL', slug: 'data/upgrades' },
            { label: 'Protect a database', slug: 'data/protection' },
            { label: 'PostgreSQL parameters', slug: 'data/parameters' },
            { label: 'Grow storage', slug: 'data/storage' },
            { label: 'Monitor a database', slug: 'data/monitoring' },
            { label: 'Extensions', slug: 'data/extensions' }
          ]
        },
        {
          label: 'Running things',
          items: [
            { label: 'Environments and variables', slug: 'run/environments' },
            { label: 'Jobs and pipelines', slug: 'run/jobs' },
            { label: 'Compose stacks', slug: 'run/compose' },
            { label: 'Templates', slug: 'run/templates' },
            { label: 'Logs and shell', slug: 'run/logs' },
            { label: 'Monitor an app', slug: 'run/monitor-an-app' },
            { label: 'Metrics and alerts', slug: 'run/observability' },
            { label: 'Alert rules', slug: 'run/alerts' },
            { label: 'Notifications', slug: 'run/notifications' },
            { label: 'Status pages', slug: 'run/status-pages' },
            { label: 'Webhooks', slug: 'run/webhooks' },
            { label: 'Terraform and OpenTofu', slug: 'run/terraform' },
            { label: 'Terminal dashboard', slug: 'run/terminal-dashboard' },
            { label: 'The Grove', slug: 'run/grove' }
          ]
        },
        {
          label: 'Greenhouse',
          items: [
            { label: 'Overview', slug: 'greenhouse' },
            { label: 'Get started', slug: 'greenhouse/getting-started' },
            { label: 'Machines', slug: 'greenhouse/machines' },
            { label: 'The workspace', slug: 'greenhouse/workspace' },
            { label: 'Open in your editor', slug: 'greenhouse/editors' },
            { label: 'Setup and run scripts', slug: 'greenhouse/scripts' },
            { label: 'Previews and ports', slug: 'greenhouse/previews' },
            { label: 'Pull requests and checks', slug: 'greenhouse/pull-requests' },
            { label: 'Attach an Orchard project', slug: 'greenhouse/projects' },
            { label: 'Sharing and multiplayer', slug: 'greenhouse/sharing' },
            { label: 'GitHub, Linear and Slack', slug: 'greenhouse/integrations' },
            { label: 'Automating Greenhouse', slug: 'greenhouse/automation' },
            { label: 'Troubleshooting', slug: 'greenhouse/troubleshooting' }
          ]
        },
        {
          label: 'Grafts (extensions)',
          items: [
            { label: 'Overview', slug: 'grafts/overview' },
            { label: 'Install grafts', slug: 'grafts/install' },
            { label: 'Upgrades and rollback', slug: 'grafts/upgrades' },
            { label: 'Announcements', slug: 'grafts/announcements' },
            { label: 'Troubleshooting', slug: 'grafts/troubleshooting' },
            { label: 'Build a graft', slug: 'grafts/build/quickstart' },
            { label: 'graft.json', slug: 'grafts/build/manifest' },
            { label: 'Server code and doors', slug: 'grafts/build/server' },
            { label: 'UI islands and slots', slug: 'grafts/build/ui' },
            { label: 'Database', slug: 'grafts/build/database' },
            { label: 'Publishing', slug: 'grafts/build/publishing' },
            { label: 'Graft API versions', slug: 'reference/graft-api' },
            { label: 'Graft UI slots', slug: 'reference/graft-slots' }
          ]
        },
        {
          label: 'Your account',
          items: [
            { label: 'Profile', slug: 'account/profile' },
            { label: 'Sign-in and sessions', slug: 'account/security' },
            { label: 'API tokens', slug: 'account/tokens' },
            { label: 'SSH identities', slug: 'account/ssh-identities' },
            { label: 'Preferences', slug: 'account/preferences' },
            { label: 'Shortcuts and search', slug: 'account/command-palette' }
          ]
        },
        {
          label: 'Teams',
          items: [
            { label: 'Organizations and roles', slug: 'teams/organizations' },
            { label: 'Manage a project', slug: 'teams/projects' },
            { label: 'SSO', slug: 'teams/sso' },
            { label: 'SCIM provisioning', slug: 'teams/scim' },
            { label: 'Audit logs', slug: 'teams/audit-logs' },
            { label: 'Quotas and usage', slug: 'teams/quotas' },
            { label: 'Review usage', slug: 'teams/usage' }
          ]
        },
        {
          label: 'Operating Orchard',
          items: [
            { label: 'Architecture', slug: 'operate/architecture' },
            { label: 'Configuration', slug: 'operate/configuration' },
            { label: 'Finishing setup', slug: 'operate/finishing-setup' },
            { label: 'Instance admin', slug: 'operate/instance-admin' },
            { label: 'Manage users', slug: 'operate/manage-users' },
            { label: 'Manage organizations', slug: 'operate/manage-organizations' },
            { label: 'Size older workloads', slug: 'operate/backfill' },
            { label: 'Host commands', slug: 'operate/host-commands' },
            { label: 'Nodes and pools', slug: 'operate/nodes' },
            { label: 'Manage node pools', slug: 'operate/node-pools' },
            { label: 'Bot protection', slug: 'operate/bot-protection' },
            { label: 'Database dumps', slug: 'operate/database-dumps' },
            { label: 'Usage reports', slug: 'operate/telemetry' },
            { label: 'Running Greenhouse', slug: 'operate/greenhouse' },
            { label: 'Upgrades', slug: 'operate/upgrades' },
            { label: 'Going to production', slug: 'operate/production' },
            { label: 'Wildcard certificates', slug: 'operate/wildcard-certificates' },
            { label: 'Security and isolation', slug: 'operate/security' },
            { label: 'Image scanning', slug: 'operate/image-scanning' },
            { label: 'Logs and request data', slug: 'operate/logs' },
            { label: 'Troubleshooting', slug: 'operate/troubleshooting' },
            { label: 'Licenses', slug: 'operate/licenses' }
          ]
        },
        {
          label: 'Interfaces',
          items: [
            { label: 'CLI', slug: 'cli' },
            { label: 'MCP for agents', slug: 'mcp' },
            { label: 'Code mode for agents', slug: 'agents-code-mode' },
            { label: 'Docs for agents', slug: 'for-agents' }
          ]
        },
        ...openAPISidebarGroups
      ]
    }),
    // Must come after starlight(), which registers expressive-code.
    mdx()
  ]
});
