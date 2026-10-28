import type { MockTemplate } from './templates.ts';

type Option = { label: string; value: string };

export type MockParameter = {
	name: string;
	displayName: string;
	description?: string;
	type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
	default?: string | number | boolean;
	required?: boolean;
	placeholder?: string;
	validation?: {
		pattern?: string;
		message?: string;
		min?: number;
		max?: number;
		bytes?: number;
		encoding?: 'hex' | 'base64';
	};
	options?: Option[];
};

export type MockResource = { name: string; type: 'deployment' | 'database' | 'ingress' };

const appName = (fallback: string): MockParameter => ({
	name: 'appName',
	displayName: 'App name',
	description: 'Used for the deployment and its internal hostname.',
	type: 'string',
	default: fallback,
	required: true,
	validation: {
		pattern: '^[a-z][a-z0-9-]{1,58}[a-z0-9]$',
		message: 'Lowercase letters, numbers and hyphens, 3 to 60 characters'
	}
});

const domain: MockParameter = {
	name: 'domain',
	displayName: 'Domain',
	description: 'Leave empty to get an orchard.my address.',
	type: 'string',
	placeholder: 'blog.example.com'
};

const adminEmail: MockParameter = {
	name: 'adminEmail',
	displayName: 'Admin email',
	type: 'string',
	required: true,
	placeholder: 'you@example.com',
	validation: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', message: 'Enter an email address' }
};

const secret = (name: string, displayName: string, bytes = 32): MockParameter => ({
	name,
	displayName,
	description: 'Generated for you if you leave it empty.',
	type: 'secret',
	validation: { bytes, encoding: 'hex' }
});

const memory: MockParameter = {
	name: 'maxMemory',
	displayName: 'Max memory',
	type: 'select',
	default: '128mb',
	options: [
		{ label: '64 MB', value: '64mb' },
		{ label: '128 MB', value: '128mb' },
		{ label: '256 MB', value: '256mb' },
		{ label: '512 MB', value: '512mb' }
	]
};

const storage = (fallback = 5): MockParameter => ({
	name: 'storageGi',
	displayName: 'Storage',
	description: 'Persistent volume size in GiB.',
	type: 'number',
	default: fallback,
	validation: { min: 1, max: 200 }
});

const SPECIFIC: Record<string, { parameters: MockParameter[]; resources: MockResource[] }> = {
	ghost: {
		parameters: [
			appName('ghost'),
			{
				name: 'siteTitle',
				displayName: 'Site title',
				type: 'string',
				default: 'My Ghost Blog',
				required: true
			},
			domain,
			adminEmail,
			{
				name: 'mailProvider',
				displayName: 'Email delivery',
				description: 'How Ghost sends newsletters and sign-in links.',
				type: 'select',
				default: 'none',
				options: [
					{ label: 'Off', value: 'none' },
					{ label: 'Mailgun', value: 'mailgun' },
					{ label: 'SMTP', value: 'smtp' }
				]
			},
			{
				name: 'members',
				displayName: 'Enable memberships',
				description: 'Let readers sign up and subscribe.',
				type: 'boolean',
				default: true
			},
			storage(10)
		],
		resources: [
			{ name: 'ghost', type: 'deployment' },
			{ name: 'ghost-db', type: 'database' },
			{ name: 'ghost-web', type: 'ingress' }
		]
	},
	n8n: {
		parameters: [
			appName('n8n'),
			domain,
			{
				name: 'timezone',
				displayName: 'Timezone',
				description: 'Used by schedule triggers.',
				type: 'select',
				default: 'America/New_York',
				options: [
					{ label: 'New York', value: 'America/New_York' },
					{ label: 'London', value: 'Europe/London' },
					{ label: 'Berlin', value: 'Europe/Berlin' },
					{ label: 'Tokyo', value: 'Asia/Tokyo' },
					{ label: 'UTC', value: 'UTC' }
				]
			},
			secret('encryptionKey', 'Encryption key'),
			{
				name: 'executionsPrune',
				displayName: 'Prune old executions',
				description: 'Delete execution data older than two weeks.',
				type: 'boolean',
				default: true
			}
		],
		resources: [
			{ name: 'n8n', type: 'deployment' },
			{ name: 'n8n-db', type: 'database' },
			{ name: 'n8n-web', type: 'ingress' }
		]
	},
	minecraft: {
		parameters: [
			appName('minecraft'),
			{
				name: 'serverType',
				displayName: 'Server type',
				type: 'select',
				default: 'PAPER',
				options: [
					{ label: 'Paper', value: 'PAPER' },
					{ label: 'Vanilla', value: 'VANILLA' },
					{ label: 'Fabric', value: 'FABRIC' },
					{ label: 'Forge', value: 'FORGE' }
				]
			},
			{
				name: 'version',
				displayName: 'Version',
				type: 'string',
				default: 'LATEST',
				placeholder: '1.21.1'
			},
			{
				name: 'maxPlayers',
				displayName: 'Max players',
				type: 'number',
				default: 20,
				validation: { min: 1, max: 200 }
			},
			{
				name: 'difficulty',
				displayName: 'Difficulty',
				type: 'select',
				default: 'normal',
				options: [
					{ label: 'Peaceful', value: 'peaceful' },
					{ label: 'Easy', value: 'easy' },
					{ label: 'Normal', value: 'normal' },
					{ label: 'Hard', value: 'hard' }
				]
			},
			{
				name: 'motd',
				displayName: 'Message of the day',
				type: 'string',
				default: 'A Minecraft server on Orchard'
			},
			{
				name: 'onlineMode',
				displayName: 'Online mode',
				description: 'Only allow players with a paid account.',
				type: 'boolean',
				default: true
			},
			secret('rconPassword', 'RCON password', 16),
			storage(10)
		],
		resources: [{ name: 'minecraft', type: 'deployment' }]
	},
	plausible: {
		parameters: [
			appName('plausible'),
			domain,
			adminEmail,
			{
				name: 'registration',
				displayName: 'Registration',
				type: 'select',
				default: 'invite_only',
				options: [
					{ label: 'Invite only', value: 'invite_only' },
					{ label: 'Open', value: 'true' },
					{ label: 'Closed', value: 'false' }
				]
			},
			secret('secretKeyBase', 'Secret key base', 64)
		],
		resources: [
			{ name: 'plausible', type: 'deployment' },
			{ name: 'plausible-events', type: 'deployment' },
			{ name: 'plausible-db', type: 'database' },
			{ name: 'plausible-web', type: 'ingress' }
		]
	},
	'redis-oss': {
		parameters: [appName('redis'), memory, secret('password', 'Password', 24)],
		resources: [{ name: 'redis', type: 'deployment' }]
	},
	redis: {
		parameters: [appName('valkey'), memory],
		resources: [{ name: 'valkey', type: 'deployment' }]
	},
	'uptime-kuma': {
		parameters: [
			appName('uptime-kuma'),
			domain,
			{
				name: 'checkInterval',
				displayName: 'Default check interval',
				description: 'Seconds between checks for new monitors.',
				type: 'number',
				default: 60,
				validation: { min: 20, max: 3600 }
			}
		],
		resources: [
			{ name: 'uptime-kuma', type: 'deployment' },
			{ name: 'uptime-kuma-web', type: 'ingress' }
		]
	}
};

function generic(t: MockTemplate) {
	const slug = t.name.replace(/[^a-z0-9-]/g, '-');
	if (t.category === 'database') {
		return {
			parameters: [
				appName(slug),
				{
					name: 'version',
					displayName: 'Version',
					type: 'select' as const,
					default: 'latest',
					options: [
						{ label: 'Latest', value: 'latest' },
						{ label: 'Previous major', value: 'previous' }
					]
				},
				secret('password', 'Password', 24),
				storage(5)
			],
			resources: [{ name: slug, type: 'deployment' as const }]
		};
	}
	const withDb = ['cms', 'analytics', 'automation', 'docs', 'monitoring', 'security'].includes(
		t.category
	);
	return {
		parameters: [
			appName(slug),
			domain,
			...(withDb ? [adminEmail] : []),
			secret('adminPassword', 'Admin password', 16),
			{
				name: 'public',
				displayName: 'Public URL',
				description: 'Expose it on the internet instead of only inside your org.',
				type: 'boolean' as const,
				default: true
			}
		],
		resources: [
			{ name: slug, type: 'deployment' as const },
			...(withDb ? [{ name: `${slug}-db`, type: 'database' as const }] : []),
			{ name: `${slug}-web`, type: 'ingress' as const }
		]
	};
}

export function templateSpec(t: MockTemplate) {
	return SPECIFIC[t.name] ?? generic(t);
}
