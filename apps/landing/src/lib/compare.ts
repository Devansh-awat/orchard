export type Cell = { text: string; href?: string };
export type Row = { feature: string; cells: Cell[] };
export type Section = { title: string; lead: string; rows: Row[] };

export const CHECKED = 'November 2026';

export const PLATFORMS = ['Orchard', 'Coolify', 'Dokploy', 'Kubero', 'Dokku', 'CapRover'];

export const VERSIONS = 'Coolify 4.7.5, Dokploy 0.31.2, Kubero 3.1.1 and CapRover 1.16.0';

const DOCS = 'https://docs.orchard.hackclub.com';

const SRC = {
	orchard: 'https://github.com/hackclub/orchard',
	coolify: 'https://github.com/coollabsio/coolify',
	coolifyBackups: 'https://coolify.io/docs/databases/backups',
	coolifyNetwork: 'https://coolify.io/docs/core/networking/destinations/overview',
	coolifyTeam: 'https://github.com/coollabsio/coolify/releases/tag/v4.4.0',
	coolifyMcp: 'https://github.com/coollabsio/coolify/pull/9862',
	coolifyScan: 'https://github.com/coollabsio/coolify/releases/tag/v4.7.0',
	coolifyRolling: 'https://coolify.io/docs/knowledge-base/rolling-updates',
	coolifyCli: 'https://github.com/coollabsio/coolify-cli',
	coolifyTerraform: 'https://pkg.go.dev/github.com/coolify-terraform/terraform-provider-coolify',
	dokploy: 'https://github.com/Dokploy/dokploy',
	dokployLicense: 'https://github.com/Dokploy/dokploy/blob/canary/LICENSE.MD',
	dokployBackups: 'https://docs.dokploy.com/docs/core/databases/backups',
	dokployNetwork: 'https://docs.dokploy.com/docs/core/docker-compose/utilities',
	dokployEnterprise: 'https://docs.dokploy.com/docs/core/enterprise',
	dokployMcp: 'https://github.com/Dokploy/mcp',
	dokployZeroDowntime: 'https://docs.dokploy.com/docs/core/applications/zero-downtime',
	dokployBuilds: 'https://docs.dokploy.com/docs/core/applications/build-type',
	dokployCli: 'https://docs.dokploy.com/docs/cli',
	kubero: 'https://github.com/kubero-dev/kubero',
	kuberoAddons: 'https://www.kubero.dev/docs/usermanual/addons/',
	kuberoFeatures: 'https://www.kubero.dev/docs/usermanual/features/',
	kuberoTeams: 'https://github.com/kubero-dev/kubero/releases/tag/v3.0.0',
	dokkuPro: 'https://dokku.com/docs/enterprise/pro/',
	dokku: 'https://github.com/dokku/dokku',
	dokkuPostgres: 'https://github.com/dokku/dokku-postgres',
	dokkuZeroDowntime: 'https://dokku.com/docs/deployment/zero-downtime-deploys/',
	dokkuBuilders: 'https://dokku.com/docs/deployment/builders/builder-management/',
	dokkuTerraform: 'https://registry.terraform.io/providers/aaronstillwell/dokku',
	caprover: 'https://github.com/caprover/caprover',
	caproverLicense: 'https://github.com/caprover/caprover/blob/master/LICENSE',
	caproverBackup: 'https://caprover.com/docs/server/backup',
	caproverInstall: 'https://get.caprover.com',
	caproverUsers: 'https://caprover.com/docs/get-started',
	caproverScaling: 'https://caprover.com/docs/scaling',
	caproverBuilds: 'https://caprover.com/docs/deployments/captain-definition',
	caproverCli: 'https://github.com/caprover/caprover-cli',
	coolifyReplicas: 'https://github.com/coollabsio/coolify/releases/tag/v4.5.0',
	coolifyMultiServer:
		'https://coolify.io/docs/core/infrastructure/scaling/multi-server-deployments',
	coolifyRollback: 'https://coolify.io/docs/applications/deployments/rollbacks',
	coolifyBasicAuth: 'https://coolify.io/docs/core/networking/proxy/traefik/basic-auth',
	coolifyTraffic: 'https://coolify.io/docs/core/observability/monitoring/traffic-analytics',
	coolifySso: 'https://coolify.io/docs/core/security/authentication/sso/overview',
	coolifyBuildSocket:
		'https://github.com/coollabsio/coolify/blob/main/app/Jobs/ApplicationDeploymentJob.php',
	dokployAdvanced: 'https://docs.dokploy.com/docs/core/applications/advanced',
	dokployDeployment: 'https://docs.dokploy.com/docs/core/deployment-options',
	dokployInstall: 'https://docs.dokploy.com/docs/core/manual-installation',
	dokployTailscale: 'https://docs.dokploy.com/docs/core/guides/tailscale',
	dokployAppAuth: 'https://docs.dokploy.com/docs/core/enterprise/sso/application-authentication',
	dokployRequests: 'https://github.com/Dokploy/dokploy/releases/tag/v0.31.0',
	dokploySso: 'https://docs.dokploy.com/docs/core/enterprise/sso',
	dokployScim: 'https://docs.dokploy.com/docs/core/enterprise/scim',
	kuberoHpa:
		'https://github.com/kubero-dev/kubero-operator/blob/main/helm-charts/kuberoapp/templates/hpa-web.yaml',
	dokkuScale: 'https://dokku.com/docs/processes/process-management/',
	dokkuK3s: 'https://dokku.com/docs/deployment/schedulers/k3s/',
	dokkuHttpAuth: 'https://github.com/dokku/dokku-http-auth',
	caproverMultiNode: 'https://caprover.com/docs/scaling/multi-node',
	dokkuNginx: 'https://dokku.com/docs/networking/proxies/nginx/',
	dokkuUsers: 'https://dokku.com/docs/deployment/user-management/',
	dokkuNetwork: 'https://dokku.com/docs/networking/network/',
	caproverNetwork:
		'https://github.com/caprover/caprover/blob/master/src/datastore/AppsDataStore.ts',
	caproverDocker: 'https://github.com/caprover/caprover/blob/master/src/docker/DockerApi.ts',
	caproverAuth: 'https://github.com/caprover/caprover-frontend',
	kuberoOauth:
		'https://github.com/kubero-dev/kubero/blob/main/server/src/auth/strategies/oauth2.strategy.ts',
	kuberoUsers: 'https://github.com/kubero-dev/kubero/blob/main/server/src/users/users.service.ts',
	kuberoBuild:
		'https://github.com/kubero-dev/kubero/blob/main/server/src/deployments/templates/nixpacks.yaml.ts',
	kuberoDeploy:
		'https://github.com/kubero-dev/kubero-operator/blob/main/helm-charts/kuberoapp/templates/deployment-web.yaml'
};

const yes = (href: string): Cell => ({ text: 'Yes', href });
const say = (text: string, href?: string): Cell => ({ text, href });
const none: Cell = { text: '' };

const ROW = {
	replicas: {
		feature: 'Several load-balanced copies of an app',
		cells: [
			say('Yes, one control', `${DOCS}/deploy/scaling/`),
			say('One per server', SRC.coolifyReplicas),
			yes(SRC.dokployAdvanced),
			say('Yes, with autoscaling', SRC.kuberoHpa),
			yes(SRC.dokkuNginx),
			say('Stateless apps', SRC.caproverScaling)
		]
	},
	selfHeal: {
		feature: 'Apps move off a server that fails',
		cells: [
			say('Multi-node clusters, apps without node-local volumes', `${DOCS}/operate/nodes/`),
			say('Not automatic', SRC.coolifyMultiServer),
			say('Through Docker Swarm', SRC.dokployDeployment),
			yes(SRC.kuberoFeatures),
			say('With the k3s scheduler', SRC.dokkuK3s),
			say('Stateless apps', SRC.caproverMultiNode)
		]
	},
	blueGreen: {
		feature: 'Blue/green deploys',
		cells: [yes(`${DOCS}/deploy/update-strategies/`), none, none, none, none, none]
	},
	drain: {
		feature: 'Apps stay up while a server drains',
		cells: [
			say(
				'Apps with more than one replica',
				`${DOCS}/deploy/update-strategies/#keep-pods-ready-during-a-node-drain`
			),
			none,
			none,
			none,
			none,
			none
		]
	},
	rollbackDb: {
		feature: 'Rollback restores the database too',
		cells: [
			say('With backup storage', `${DOCS}/deploy/rollbacks/`),
			say('No', SRC.coolifyRollback),
			none,
			none,
			none,
			none
		]
	},
	tailscale: {
		feature: 'Private apps on Tailscale',
		cells: [
			say('Built in', `${DOCS}/deploy/tailscale/`),
			none,
			say('Manual guide', SRC.dokployTailscale),
			none,
			none,
			none
		]
	},
	pooler: {
		feature: 'Connection pooler',
		cells: [yes(`${DOCS}/data/connection-pooler/`), none, none, none, none, none]
	},
	upgrades: {
		feature: 'Postgres major upgrades',
		cells: [
			say('After a rehearsal on a copy', `${DOCS}/data/upgrades/`),
			none,
			none,
			none,
			none,
			none
		]
	},
	restoreTests: {
		feature: 'Automatic restore tests',
		cells: [
			say('Weekly, with backup storage', `${DOCS}/data/protection/`),
			none,
			none,
			none,
			none,
			none
		]
	},
	buildIsolation: {
		feature: 'Builds kept apart from the host',
		cells: [
			say('Rootless BuildKit per project', `${DOCS}/operate/security/`),
			say('Uses the host Docker socket', SRC.coolifyBuildSocket),
			say('Uses the host Docker socket', SRC.dokployInstall),
			say('Privileged build pod', SRC.kuberoBuild),
			say('Uses the host Docker daemon', SRC.dokkuBuilders),
			say('Uses the host Docker socket', SRC.caproverDocker)
		]
	},
	sandbox: {
		feature: 'Kernel sandbox for untrusted apps',
		cells: [
			say('gVisor or Kata, optional', `${DOCS}/operate/security/`),
			none,
			none,
			none,
			none,
			none
		]
	},
	gate: {
		feature: 'Sign-in or password in front of any app',
		cells: [
			say('Sign-in or password, free', `${DOCS}/deploy/protection/`),
			say('Password; sign-in set up by hand', SRC.coolifyBasicAuth),
			say('Password; sign-in on Enterprise plan', SRC.dokployAppAuth),
			say('Password', SRC.kuberoFeatures),
			say('Password, through a plugin', SRC.dokkuHttpAuth),
			say('Password', SRC.caproverAuth)
		]
	},
	requests: {
		feature: 'Request analytics and attack signals',
		cells: [
			say('Both, with Traefik or HAProxy', `${DOCS}/deploy/security-tab/`),
			say('Requests', SRC.coolifyTraffic),
			say('Requests', SRC.dokployRequests),
			say('Response times', SRC.kuberoFeatures),
			none,
			none
		]
	},
	orgSso: {
		feature: 'Each organization brings its own SSO',
		cells: [
			yes(`${DOCS}/teams/sso/`),
			say('No, one for the instance', SRC.coolifySso),
			say('Enterprise plan', SRC.dokploySso),
			say('No, one for the instance', SRC.kuberoOauth),
			say('No user accounts', SRC.dokkuUsers),
			say('No user accounts', SRC.caproverUsers)
		]
	},
	domains: {
		feature: 'Verified domains and required SSO',
		cells: [
			yes(`${DOCS}/teams/sso/#verify-an-email-domain`),
			none,
			say('Required SSO on Enterprise plan', SRC.dokploySso),
			none,
			say('No user accounts', SRC.dokkuUsers),
			say('No user accounts', SRC.caproverUsers)
		]
	},
	jit: {
		feature: 'Accounts created on first sign-in',
		cells: [
			say('Into any organization, by group', `${DOCS}/operate/identity-bridge/`),
			say('Into the root team only', SRC.coolifySso),
			none,
			say('With one default role', SRC.kuberoUsers),
			say('No user accounts', SRC.dokkuUsers),
			say('No user accounts', SRC.caproverUsers)
		]
	},
	scim: {
		feature: 'SCIM provisioning',
		cells: [
			say('Free, per organization or instance', `${DOCS}/teams/scim/`),
			none,
			say('Enterprise plan', SRC.dokployScim),
			none,
			say('No user accounts', SRC.dokkuUsers),
			say('No user accounts', SRC.caproverUsers)
		]
	},
	groups: {
		feature: 'Provider groups set roles',
		cells: [
			yes(`${DOCS}/teams/sso/#map-provider-groups-to-roles`),
			say('No', SRC.coolifySso),
			none,
			say('No', SRC.kuberoUsers),
			say('No user accounts', SRC.dokkuUsers),
			say('No user accounts', SRC.caproverUsers)
		]
	},
	ldap: {
		feature: 'LDAP and Active Directory',
		cells: [
			say('Through Dex or Keycloak', `${DOCS}/operate/identity-bridge/`),
			none,
			none,
			none,
			none,
			none
		]
	},
	grafts: {
		feature: 'Extensions with their own pages and APIs',
		cells: [yes(`${DOCS}/grafts/overview/`), none, none, none, say('CLI plugins', SRC.dokku), none]
	},
	dashboard: {
		feature: 'Web dashboard',
		cells: [
			yes(`${DOCS}/start/first-deploy/`),
			yes(SRC.coolify),
			yes(SRC.dokploy),
			yes(SRC.kubero),
			say('Paid add-on', SRC.dokkuPro),
			yes(SRC.caprover)
		]
	},
	license: {
		feature: 'License',
		cells: [
			say('AGPL-3.0', `${DOCS}/operate/licenses/`),
			say('Apache-2.0', SRC.coolify),
			say('Apache-2.0, some parts source-available', SRC.dokployLicense),
			say('GPL-3.0', SRC.kubero),
			say('MIT', SRC.dokku),
			say('Apache-2.0 with terms for paid features', SRC.caproverLicense)
		]
	},
	backups: {
		feature: 'Postgres backups',
		cells: [
			say('Continuous, to S3', `${DOCS}/data/backups/`),
			say('Scheduled dumps', SRC.coolifyBackups),
			say('Scheduled dumps', SRC.dokployBackups),
			say('Through an add-on', SRC.kuberoAddons),
			say('Scheduled dumps, through a plugin', SRC.dokkuPostgres),
			say('Instance settings only', SRC.caproverBackup)
		]
	},
	pitr: {
		feature: 'Point-in-time restore',
		cells: [
			say('To any second in 30 days, with backup storage', `${DOCS}/data/backups/`),
			none,
			none,
			none,
			none,
			none
		]
	},
	failover: {
		feature: 'Postgres failover and read replicas',
		cells: [
			say('Yes, with synchronous replication', `${DOCS}/data/high-availability/`),
			none,
			none,
			say('Through a third-party add-on', SRC.kuberoAddons),
			none,
			none
		]
	},
	forks: {
		feature: 'Database forks',
		cells: [
			yes(`${DOCS}/data/backups/`),
			none,
			none,
			none,
			say('Through a plugin', SRC.dokkuPostgres),
			none
		]
	},
	isolation: {
		feature: 'Network isolation between apps by default',
		cells: [
			say('Yes, default-deny', `${DOCS}/operate/security/#network-isolation`),
			say('Shared Docker network', SRC.coolifyNetwork),
			say('Shared Docker network', SRC.dokployNetwork),
			none,
			say('Shared Docker network', SRC.dokkuNetwork),
			say('Shared Docker network', SRC.caproverNetwork)
		]
	},
	scanning: {
		feature: 'Image vulnerability scanning',
		cells: [
			yes(`${DOCS}/operate/image-scanning/`),
			say('Yes, opt-in', SRC.coolifyScan),
			none,
			yes(SRC.kuberoFeatures),
			none,
			none
		]
	},
	sso: {
		feature: 'Single sign-on',
		cells: [
			say('OIDC, SAML and SCIM, free', `${DOCS}/teams/sso/`),
			say('OIDC', SRC.coolifySso),
			say('Enterprise plan', SRC.dokployEnterprise),
			say('OAuth2', SRC.kuberoOauth),
			say('No user accounts', SRC.dokkuUsers),
			say('No user accounts', SRC.caproverUsers)
		]
	},
	audit: {
		feature: 'Audit log',
		cells: [
			yes(`${DOCS}/teams/audit-logs/`),
			yes(SRC.coolifyTeam),
			say('Enterprise plan', SRC.dokployEnterprise),
			yes(SRC.kuberoTeams),
			none,
			none
		]
	},
	quotas: {
		feature: 'CPU and memory quotas per organization',
		cells: [yes(`${DOCS}/teams/quotas/`), none, none, none, none, none]
	},
	zeroDowntime: {
		feature: 'Deploys without downtime',
		cells: [
			say('Rolling or blue/green, apps without volumes', `${DOCS}/deploy/update-strategies/`),
			say('Rolling, not for Compose apps', SRC.coolifyRolling),
			yes(SRC.dokployZeroDowntime),
			say('Rolling, through Kubernetes', SRC.kuberoDeploy),
			yes(SRC.dokkuZeroDowntime),
			say('Apps without volumes', SRC.caproverScaling)
		]
	},
	noDockerfile: {
		feature: 'Builds without a Dockerfile',
		cells: [
			yes(`${DOCS}/deploy/builds/`),
			yes(SRC.coolify),
			yes(SRC.dokployBuilds),
			yes(SRC.kuberoFeatures),
			yes(SRC.dokkuBuilders),
			say('Needs a captain-definition file', SRC.caproverBuilds)
		]
	},
	mcp: {
		feature: 'Built-in MCP server',
		cells: [
			yes(`${DOCS}/mcp/`),
			yes(SRC.coolifyMcp),
			say('Separate package', SRC.dokployMcp),
			none,
			none,
			none
		]
	},
	cli: {
		feature: 'Official CLI',
		cells: [
			yes(`${DOCS}/cli/`),
			yes(SRC.coolifyCli),
			yes(SRC.dokployCli),
			yes(SRC.kubero),
			yes(SRC.dokku),
			yes(SRC.caproverCli)
		]
	},
	terraform: {
		feature: 'Terraform provider',
		cells: [
			say('Official', `${DOCS}/run/terraform/`),
			say('Community', SRC.coolifyTerraform),
			none,
			none,
			say('Community', SRC.dokkuTerraform),
			none
		]
	}
} satisfies Record<string, Row>;

export const GLANCE: Row[] = [
	ROW.dashboard,
	ROW.license,
	ROW.replicas,
	ROW.pitr,
	ROW.failover,
	ROW.isolation,
	ROW.sso,
	ROW.quotas,
	ROW.mcp
];

export const SECTIONS: Section[] = [
	{
		title: 'Deploy and scale',
		lead: 'Orchard runs every app on Kubernetes. Add copies of an app and traffic spreads across them, and a new version takes traffic only once it passes its health checks.',
		rows: [
			ROW.replicas,
			ROW.selfHeal,
			ROW.zeroDowntime,
			ROW.blueGreen,
			ROW.drain,
			ROW.rollbackDb,
			ROW.noDockerfile,
			ROW.tailscale
		]
	},
	{
		title: 'Databases',
		lead: 'Orchard runs Postgres with CloudNativePG. Backups stream all day instead of once a night, and a standby takes over if the primary fails.',
		rows: [
			ROW.backups,
			ROW.pitr,
			ROW.failover,
			ROW.forks,
			ROW.pooler,
			ROW.upgrades,
			ROW.restoreTests
		]
	},
	{
		title: 'Isolation and security',
		lead: 'Apps cannot reach each other or the platform over the network by default. They share the host kernel until you turn on a sandbox, so set one up before you let people you do not trust deploy code.',
		rows: [ROW.isolation, ROW.buildIsolation, ROW.sandbox, ROW.gate, ROW.requests, ROW.scanning]
	},
	{
		title: 'Teams and identity',
		lead: 'Each organization brings its own sign-in, and people arrive with the right role. All of it is in the free, open-source project.',
		rows: [
			ROW.orgSso,
			ROW.sso,
			ROW.domains,
			ROW.jit,
			ROW.scim,
			ROW.groups,
			ROW.ldap,
			ROW.audit,
			ROW.quotas
		]
	},
	{
		title: 'Interfaces',
		lead: 'Use the dashboard, the CLI, an AI agent or infrastructure as code, and extend Orchard with grafts.',
		rows: [ROW.dashboard, ROW.cli, ROW.mcp, ROW.terraform, ROW.grafts, ROW.license]
	}
];
