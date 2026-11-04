import { dashboardHost, parentDomain, type SetupOverview } from './setup-overview';

export type SettingChange = {
	title: string;
	how: string;
	command?: string;
	values?: string;
	language?: string;
	effect: string;
	note?: string;
};

export type SettingChanges = Partial<
	Record<
		'dashboard' | 'apps' | 'mcp' | 'letsencrypt' | 'public-ip' | 'custom-domains' | 'limits',
		SettingChange
	>
>;

const HELM_APPLY = 'Apply with your usual helm upgrade or GitOps.';

function hostOf(url: string | null): string {
	if (!url) return '';
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

function withHost(url: string | null, host: string, fallbackScheme = 'https'): string {
	try {
		const parsed = new URL(url ?? '');
		parsed.hostname = host;
		return parsed.origin;
	} catch {
		return `${fallbackScheme}://${host}`;
	}
}

function firstStep(mode: string | null, wildcard: string | null): string {
	if (mode === 'lan') return '';
	const record = wildcard ? `a wildcard record for ${wildcard}` : 'a DNS record';
	if (mode === 'tunnel') {
		return wildcard
			? ` Add ${wildcard} to your Cloudflare Tunnel first.`
			: ' Add the name to your Cloudflare Tunnel first.';
	}
	return ` Create ${record} first.`;
}

function installerChanges(overview: SetupOverview): SettingChanges {
	const host = dashboardHost(overview) || '<new-domain>';
	const apps = overview.appDomain || '<new-domain>';
	const mcpHost = hostOf(overview.mcp.url);
	const run = (what: string) => `Run this on the server, with the new ${what}.`;

	const changes: SettingChanges = {
		dashboard: {
			title: 'Dashboard domain',
			how: run('domain'),
			command: `sudo orchardctl hostname set ${host} --apply`,
			effect: `Everyone signs in again, and passkeys stop working.${firstStep(overview.mode, null)}`
		},
		apps: {
			title: 'Apps domain',
			how: run('domain'),
			command: `sudo orchardctl apps-domain set ${apps} --apply`,
			effect: `Only new apps use it. Deployed apps keep their addresses.${firstStep(overview.mode, `*.${apps}`)}`
		},
		mcp: overview.mcp.deployed
			? {
					title: 'MCP hostname',
					how: run('hostname'),
					command: `sudo orchardctl mcp enable ${mcpHost || '<new-hostname>'} --apply`,
					effect: `Agents reconnect at the new address.${overview.mode === 'lan' ? '' : ' A name directly under the apps domain needs no DNS record of its own.'}`
				}
			: {
					title: 'MCP endpoint',
					how: 'Run this on the server.',
					command: 'sudo orchardctl mcp enable --apply',
					effect: 'Deploys the endpoint so that AI agents can connect.'
				}
	};

	if (overview.mode === 'public') {
		changes.letsencrypt = {
			title: "Let's Encrypt email",
			how: run('address'),
			command: 'sudo orchardctl letsencrypt-email set you@example.com',
			effect: "Changes where Let's Encrypt sends notices. Certificates don't change.",
			note: 'To read the current address, run sudo orchardctl letsencrypt-email.'
		};
	}

	if (overview.locked.publicIp) {
		changes['public-ip'] = {
			title: 'Public IP',
			how: run('address'),
			command: `sudo orchardctl public-ip set ${overview.publicIp || '<ip>'} --apply`,
			effect:
				'Ports and databases that are already public stay on the old address until you turn public access off and on again.',
			note: 'To edit it here instead, run sudo orchardctl public-ip unset --apply.'
		};
	}

	if (overview.locked.cname) {
		changes['custom-domains'] = {
			title: 'Custom domains target',
			how: run('hostname'),
			command: `sudo orchardctl env set INGRESS_CNAME ${overview.cname || '<new-hostname>'} --apply`,
			effect:
				'Domains already added keep working while their CNAME reaches this server. Orchard checks new domains against the new target.',
			note: 'To edit it here instead, run sudo orchardctl env unset INGRESS_CNAME --apply.'
		};
	}

	if (overview.locked.limits) {
		changes.limits = {
			title: 'Resource limits',
			how: 'Run this on the server to choose here instead.',
			command: 'sudo orchardctl env unset INSTANCE_RESOURCE_LIMITS --apply',
			effect: 'Limits stay as they are until you choose.'
		};
	}

	return changes;
}

function helmChanges(overview: SetupOverview): SettingChanges {
	const host = dashboardHost(overview) || 'orchard.example.com';
	const apps = overview.appDomain || 'apps.example.com';
	const suggestedMcp = `mcp.${parentDomain(host)}`;
	const mcpHost = hostOf(overview.mcp.url) || suggestedMcp;
	const set = (what: string) => `Set this in your Helm values, with the new ${what}. ${HELM_APPLY}`;

	const changes: SettingChanges = {
		dashboard: {
			title: 'Dashboard domain',
			how: set('domain'),
			language: 'yaml',
			values: `ingress:
  host: ${host}
server:
  env:
    - name: FRONTEND_URL
      value: ${withHost(overview.dashboardUrl, host)}`,
			effect: `Everyone signs in again, and passkeys stop working.${firstStep(null, null)}`,
			note: 'Keep the other server.env entries. If a Secret sets FRONTEND_URL, change it there instead.'
		},
		mcp: overview.mcp.deployed
			? {
					title: 'MCP hostname',
					how: set('hostname'),
					language: 'yaml',
					values: `mcp:
  url: ${withHost(overview.mcp.url, mcpHost)}
  ingress:
    host: ${mcpHost}`,
					effect: `Agents reconnect at the new address.${firstStep(null, null)}`,
					note: 'If a Secret sets MCP_BASE_URL, change it there too.'
				}
			: {
					title: 'MCP endpoint',
					how: `Set this in your Helm values. ${HELM_APPLY}`,
					language: 'yaml',
					values: `mcp:
  enabled: true
  ingress:
    host: ${mcpHost}`,
					effect: `Deploys the endpoint so that AI agents can connect.${firstStep(null, null)}`,
					note: 'Also set JWT_SECRET and MCP_SERVICE_TOKEN in mcp.env, and the same MCP_SERVICE_TOKEN in server.env.'
				}
	};

	if (overview.locked.appDomain) {
		changes.apps = {
			title: 'Apps domain',
			how: set('domain'),
			language: 'yaml',
			values: `gateway:
  http:
    appDomain: ${apps}`,
			effect: `Only new apps use it. Deployed apps keep their addresses.${firstStep(null, `*.${apps}`)}`,
			note: 'If you also set APP_DOMAIN or tenant.wildcardDomains, change them to match.'
		};
	}

	if (overview.certIssuer) {
		changes.letsencrypt = {
			title: 'Certificate issuer email',
			how: "The Orchard chart doesn't manage this issuer. Set the address where you manage cert-manager.",
			language: 'yaml',
			values: `apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: ${overview.certIssuer}
spec:
  acme:
    email: you@example.com`,
			effect: "Changes where the certificate authority sends notices. Certificates don't change."
		};
	}

	if (overview.locked.publicIp) {
		changes['public-ip'] = {
			title: 'Public IP',
			how: set('address'),
			language: 'yaml',
			values: `tenant:
  publicIp: "${overview.publicIp || '203.0.113.10'}"`,
			effect:
				'Ports and databases that are already public stay on the old address until you turn public access off and on again.',
			note: 'To edit it here instead, remove it from your values.'
		};
	}

	if (overview.locked.cname) {
		changes['custom-domains'] = {
			title: 'Custom domains target',
			how: set('hostname'),
			language: 'yaml',
			values: `server:
  env:
    - name: INGRESS_CNAME
      value: ${overview.cname || 'ingress.example.com'}`,
			effect:
				'Domains already added keep working while their CNAME reaches this instance. Orchard checks new domains against the new target.',
			note: 'To edit it here instead, remove it from your values.'
		};
	}

	if (overview.locked.limits) {
		changes.limits = {
			title: 'Resource limits',
			how: `Remove INSTANCE_RESOURCE_LIMITS from server.env in your Helm values to choose here instead. ${HELM_APPLY}`,
			effect: 'Limits stay as they are until you choose.'
		};
	}

	return changes;
}

export function settingChanges(overview: SetupOverview | null): SettingChanges {
	if (!overview) return {};
	return overview.installer ? installerChanges(overview) : helmChanges(overview);
}
