import { freshId, uid } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';
import { ssoProviderRow } from '../serialize.ts';
import type { MockSsoProvider } from '../types.ts';
import { SSO_PRESETS, applyProviderInput, iconDataUrl } from './settings.ts';
import { configSections, mockSetup, storageSection } from './shell.ts';

const provider = (overrides: Partial<MockSsoProvider> & { name: string }): MockSsoProvider => {
	const now = new Date().toISOString();
	return {
		id: uid(`sso:instance:${overrides.name}`),
		organizationId: null,
		slug: overrides.name.toLowerCase().replaceAll(' ', '-'),
		preset: 'generic',
		protocol: 'oidc',
		enabled: true,
		buttonLabel: null,
		iconUrl: null,
		sortOrder: 0,
		issuerUrl: null,
		clientId: null,
		clientSecret: null,
		scopes: null,
		authorizationUrl: null,
		tokenUrl: null,
		userinfoUrl: null,
		samlEntryPoint: null,
		samlIssuer: null,
		samlIdpEntityId: null,
		samlCertificate: null,
		samlMetadataUrl: null,
		jitProvisioning: true,
		defaultRole: 'member',
		allowedDomains: [],
		requireVerifiedEmail: true,
		trustEmail: false,
		lastUsedAt: null,
		createdAt: now,
		updatedAt: now,
		...overrides
	};
};

const EXTRA_ORGS = [
	{ id: 'org-robotics', name: 'Robotics Club', slug: 'robotics', providers: 1, domains: 1 },
	{ id: 'org-sandbox', name: 'Sandbox', slug: 'sandbox', providers: 0, domains: 0 },
	{ id: 'org-events', name: 'Events Team', slug: 'events', providers: 2, domains: 2 }
];

const section = (
	id: string,
	values: Record<string, string | null>,
	extra: { secretFields?: string[]; boolFields?: string[]; lockedFields?: string[] } = {}
) => ({
	id,
	configured: Object.values(values).some(Boolean),
	values,
	lockedFields: extra.lockedFields ?? [],
	secretFields: extra.secretFields ?? [],
	boolFields: extra.boolFields ?? []
});

const GRAFTS = [
	{
		id: 'greenhouse',
		status: 'loaded',
		phase: null,
		reason: null,
		warnings: [],
		name: 'Greenhouse',
		version: '1.4.2',
		publisher: 'Orchard',
		description: 'Cloud coding sandboxes with runners, worktrees and a browser editor.',
		capabilities: ['db', 'http', 'settings', 'kubernetes'],
		permissions: {},
		coreReads: { users: ['id', 'email', 'username'], organizations: ['id', 'slug'] },
		adopts: ['sandboxes'],
		signature: { tier: 'official', keyId: 'orchard-2026', signedBy: 'official' },
		claims: [
			{ kind: 'route', value: '/greenhouse', state: 'own' },
			{ kind: 'page', value: '/sandboxes', state: 'alias' }
		],
		routes: [
			{ method: 'GET', path: '/apiv1/greenhouse/sessions', classification: 'authenticated' },
			{ method: 'POST', path: '/apiv1/greenhouse/sessions', classification: 'authenticated' },
			{ method: 'DELETE', path: '/apiv1/greenhouse/sessions/:id', classification: 'authenticated' },
			{ method: 'GET', path: '/apiv1/greenhouse/admin/runners', classification: 'superadmin' }
		],
		migrationsApplied: [],
		dbRole: 'ext_greenhouse',
		dbPool: { total: 6, idle: 4, waiting: 0, max: 10 },
		dbPoolSize: { size: 10, source: 'graft' },
		settings: [{ id: 'runners', title: 'Greenhouse runners' }]
	},
	{
		id: 'forum',
		status: 'loaded',
		phase: null,
		reason: null,
		warnings: ['forum asked for 25 connections per pod, so it was held to 15 by your values.'],
		name: 'Forum',
		version: '0.9.0',
		publisher: 'Campfire Labs',
		description: 'Threaded discussions for every organization on this instance.',
		capabilities: ['db', 'http', 'email'],
		permissions: {},
		coreReads: { users: ['id', 'username'] },
		adopts: [],
		signature: {
			tier: 'community',
			keyId: 'c4f1a9',
			publisher: 'campfire-labs',
			repo: 'campfire-labs/orchard-forum',
			signedBy: 'publisher'
		},
		claims: [
			{ kind: 'route', value: '/forum', state: 'own' },
			{ kind: 'path', value: '/community', state: 'alias' },
			{ kind: 'path', value: '/discuss', state: 'shadowed', shadowedBy: 'announcements' }
		],
		routes: [
			{ method: 'GET', path: '/apiv1/forum/threads', classification: 'public' },
			{ method: 'GET', path: '/apiv1/forum/threads/:id', classification: 'public' },
			{ method: 'POST', path: '/apiv1/forum/threads', classification: 'authenticated' },
			{ method: 'DELETE', path: '/apiv1/forum/threads/:id', classification: 'superadmin' }
		],
		migrationsApplied: ['0004_thread_tags'],
		dbRole: 'ext_forum',
		dbPool: { total: 3, idle: 3, waiting: 0, max: 15 },
		dbPoolSize: { size: 15, source: 'values' },
		settings: []
	},
	{
		id: 'status-board',
		status: 'loaded',
		phase: null,
		reason: null,
		warnings: [],
		name: 'Status Board',
		version: '2.1.0',
		publisher: 'Northwind',
		description: 'A public status page fed by your deploys.',
		capabilities: [],
		permissions: {},
		coreReads: {},
		adopts: [],
		signature: { tier: 'tap', keyId: 'd19e07', tap: 'northwind', signedBy: 'publisher' },
		claims: [{ kind: 'route', value: '/status-board', state: 'own' }],
		routes: [],
		migrationsApplied: [],
		dbRole: null,
		dbPool: null,
		dbPoolSize: null,
		settings: []
	},
	{
		id: 'legacy-reports',
		status: 'failed',
		phase: 'migrate',
		reason: 'Migration 0002_report_rollups failed: permission denied for schema public.',
		warnings: [],
		name: 'Legacy Reports',
		version: null,
		publisher: 'Unknown Corp',
		description: null,
		capabilities: ['db'],
		permissions: {},
		coreReads: {},
		adopts: [],
		signature: null,
		claims: [],
		routes: [],
		migrationsApplied: [],
		dbRole: null,
		dbPool: null,
		dbPoolSize: { size: 5, source: 'default' },
		settings: []
	}
];

export function adminSystemRoutes(r: Router, { store }: MockContext) {
	store.state.ssoProviders.push(
		provider({
			name: 'Google Workspace',
			preset: 'google',
			issuerUrl: 'https://accounts.google.com',
			clientId: 'mock-google-client',
			clientSecret: 'stored',
			allowedDomains: ['hackclub.com', 'example.org']
		}),
		provider({
			name: 'GitHub',
			preset: 'github',
			protocol: 'oauth2',
			clientId: 'mock-github-client',
			clientSecret: 'stored',
			authorizationUrl: 'https://github.com/login/oauth/authorize',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			userinfoUrl: 'https://api.github.com/user',
			enabled: false
		}),
		provider({ name: 'Acme Okta', preset: 'generic', protocol: 'saml' })
	);

	const instanceProviders = () =>
		store.state.ssoProviders.filter((p) => p.organizationId === null).map(ssoProviderRow);
	const instanceProvider = (id: string) =>
		store.state.ssoProviders.find((p) => p.id === id && p.organizationId === null);

	const allowed = new Map<string, boolean>([[store.state.orgs[0]?.id ?? '', true]]);
	const orgStatuses = () => [
		...store.state.orgs.map((org) => ({
			organizationId: org.id,
			name: org.name,
			slug: org.slug,
			platformEnabled: allowed.get(org.id) ?? false,
			enabled: allowed.get(org.id) ?? false,
			enforced: false,
			providerCount: store.state.ssoProviders.filter((p) => p.organizationId === org.id).length,
			domainCount: 0,
			loginUrl: `http://localhost:3000/login/${org.slug}`
		})),
		...EXTRA_ORGS.map((org) => ({
			organizationId: org.id,
			name: org.name,
			slug: org.slug,
			platformEnabled: allowed.get(org.id) ?? org.id === 'org-events',
			enabled: allowed.get(org.id) ?? org.id === 'org-events',
			enforced: org.id === 'org-events',
			providerCount: org.providers,
			domainCount: org.domains,
			loginUrl: `http://localhost:3000/login/${org.slug}`
		}))
	];

	let enforced = false;
	const enforcement = () => ({
		enabled: enforced,
		dbValue: enforced,
		envOverride: null,
		providersAvailable: instanceProviders().some((p) => p.enabled && p.usable)
	});

	r.get('/admin/sso', () => ({
		providers: instanceProviders(),
		presets: SSO_PRESETS,
		organizations: orgStatuses(),
		envProvider: { id: 'env', name: 'Hack Club', preset: 'hackclub', label: 'Hack Club' },
		enforcement: enforcement()
	}));
	r.patch('/admin/sso/enforcement', ({ body }) => {
		if (body?.enabled && !enforcement().providersAvailable) {
			return reply(400, {
				statusCode: 400,
				message: 'Add and enable at least one identity provider before requiring single sign-on'
			});
		}
		enforced = Boolean(body?.enabled);
		return enforcement();
	});
	r.post('/admin/sso/providers', ({ body }) => {
		const name = String(body?.name ?? '').trim();
		if (!name) return reply(400, { statusCode: 400, message: 'Provider name is required' });
		const created = provider({ name, id: freshId() });
		applyProviderInput(created, body);
		store.state.ssoProviders.push(created);
		return ssoProviderRow(created);
	});
	r.patch('/admin/sso/providers/:id', ({ params, body }) => {
		const found = instanceProvider(params.id);
		if (!found) return notFound('Identity provider not found');
		applyProviderInput(found, body);
		return ssoProviderRow(found);
	});
	r.delete('/admin/sso/providers/:id', ({ params }) => {
		if (!instanceProvider(params.id)) return notFound('Identity provider not found');
		store.state.ssoProviders = store.state.ssoProviders.filter((p) => p.id !== params.id);
		return { ok: true };
	});
	r.post('/admin/sso/providers/:id/icon', ({ params, body }) => {
		const found = instanceProvider(params.id);
		if (!found) return notFound('Identity provider not found');
		const url = iconDataUrl(body?.files?.file);
		if (typeof url !== 'string') return url;
		found.iconUrl = url;
		return ssoProviderRow(found);
	});
	r.delete('/admin/sso/providers/:id/icon', ({ params }) => {
		const found = instanceProvider(params.id);
		if (!found) return notFound('Identity provider not found');
		found.iconUrl = null;
		return ssoProviderRow(found);
	});
	r.post('/admin/sso/providers/:id/test', ({ params }) => {
		const found = instanceProvider(params.id);
		if (!found) return notFound('Identity provider not found');
		return found.protocol === 'saml'
			? { success: false, error: 'The metadata URL answered 404.' }
			: { success: true };
	});
	r.patch('/admin/sso/organizations/:id', ({ params, body }) => {
		allowed.set(params.id, Boolean(body?.platformEnabled));
		return { ok: true };
	});

	r.get('/admin/grafts', () => ({
		platform: '1.42.0',
		sdk: '1.3.0',
		trust: 'taps',
		taps: [{ name: 'northwind', url: 'https://grafts.northwind.dev/index.json', keyId: 'd19e07' }],
		doors: {},
		database: {
			usable: 97,
			inUse: 18,
			perPod: 34,
			steadyPeak: 68,
			rolloutPeak: 72,
			level: 'ok',
			summary:
				"At peak, Orchard and its grafts could open 68 of the database's 97 connections, and 72 while an update runs old and new pods side by side."
		},
		grafts: GRAFTS
	}));

	const saved: Record<string, Record<string, string>> = {};
	const withSaved = <T extends { id: string; values: Record<string, unknown> }>(s: T) => ({
		...s,
		values: { ...s.values, ...saved[s.id] }
	});

	const emailSection = () =>
		section(
			'email',
			{
				host: 'smtp.postmarkapp.com',
				port: '587',
				user: 'orchard',
				pass: '',
				secure: '',
				from: 'orchard@example.com',
				fromName: 'Orchard'
			},
			{ secretFields: ['pass'] }
		);
	const turnstileSection = () =>
		section(
			'turnstile',
			{ siteKey: '', secretKey: '', enabled: 'true', strict: 'false' },
			{ secretFields: ['secretKey'], boolFields: ['enabled', 'strict'] }
		);
	const gitlabSection = () =>
		section(
			'git-gitlab',
			{ baseUrl: '', clientId: '', clientSecret: '' },
			{ secretFields: ['clientSecret'] }
		);
	const bitbucketSection = () =>
		section('git-bitbucket', { key: '', secret: '' }, { secretFields: ['secret'] });
	const graftSection = () => ({
		...section(
			'forum.moderation',
			{ moderators: 'alfd', autoLock: 'false' },
			{ boolFields: ['autoLock'] }
		),
		graft: {
			id: 'forum',
			title: 'Forum moderation',
			description: 'Who keeps threads tidy.',
			fields: {
				moderators: { label: 'Moderators', help: 'Comma-separated usernames.' },
				autoLock: { label: 'Lock quiet threads', help: 'After 90 days without a reply.' }
			}
		}
	});

	const sections = () => [
		storageSection,
		withSaved(emailSection()),
		...configSections().map(withSaved),
		withSaved(turnstileSection()),
		withSaved(gitlabSection()),
		withSaved(bitbucketSection()),
		withSaved(graftSection())
	];
	const sectionView = (id: string) => sections().find((s) => s.id === id);
	const save = (id: string, body: Record<string, string> | null) => {
		const secret = (sectionView(id)?.secretFields ?? []) as string[];
		const values = Object.fromEntries(
			Object.entries(body ?? {}).filter(([name]) => !secret.includes(name))
		);
		saved[id] = { ...saved[id], ...values };
		return sectionView(id);
	};

	r.get('/admin/instance-config', () => sections());
	r.put('/admin/instance-config/email', ({ body }) => {
		mockSetup.email = !!body?.host;
		return save('email', body);
	});
	r.put('/admin/instance-config/ingress', ({ body }) => {
		mockSetup.cname = body?.cname || null;
		return save('ingress', body);
	});
	r.put('/admin/instance-config/wildcard', ({ body }) => {
		const { appDomain: _locked, ...rest } = body ?? {};
		return save('wildcard', rest);
	});
	r.put('/admin/instance-config/network', ({ body }) => {
		if (body?.publicIp && !/^[\d.:a-fA-F]+$/.test(body.publicIp)) {
			return reply(400, {
				statusCode: 400,
				message: 'publicIp must be a valid IPv4 or IPv6 address'
			});
		}
		mockSetup.publicIp = body?.publicIp || null;
		return save('network', body);
	});
	r.put('/admin/instance-config/:id', ({ params, body }) =>
		sectionView(params.id) ? save(params.id, body) : notFound('Unknown configuration section')
	);

	let mcp = true;
	const mcpView = () => ({ enabled: mcp, dbValue: mcp, envOverride: null });
	r.get('/admin/instance-settings/mcp', () => mcpView());
	r.patch('/admin/instance-settings/mcp', ({ body }) => {
		mcp = Boolean(body?.enabled);
		return mcpView();
	});

	const domainProofView = () => ({
		enabled: store.requireDomainProof,
		dbValue: store.requireDomainProof,
		envOverride: null
	});
	r.get('/admin/instance-settings/custom-domain-verification', () => domainProofView());
	r.patch('/admin/instance-settings/custom-domain-verification', ({ body }) => {
		store.requireDomainProof = Boolean(body?.enabled);
		return domainProofView();
	});

	r.get('/admin/telemetry/preview', () => ({
		event: 'instance_report',
		distinctId: 'a3f0c1d2-7b1e-4b6a-9f55-2c8d90e4b7aa',
		properties: {
			orchardVersion: '1.42.0',
			nodeVersion: '22.22.3',
			arch: 'arm64',
			users: store.state.users.length,
			organizations: store.state.orgs.length,
			projects: store.state.projects.length,
			deployments: store.state.deployments.length,
			buildsSucceeded24h: 14,
			buildsFailed24h: 2,
			githubConfigured: true,
			emailConfigured: mockSetup.email,
			ssoConfigured: true
		}
	}));
}
