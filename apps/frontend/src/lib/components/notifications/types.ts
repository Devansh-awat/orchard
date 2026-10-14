export type NotificationScopeType = 'org' | 'project' | 'deployment' | 'database' | 'job';

export type CoreNotificationCategory = 'deploys' | 'health' | 'jobs' | 'data' | 'security';

export type NotificationCategory = CoreNotificationCategory | (string & {});

export const CORE_CATEGORIES: CoreNotificationCategory[] = [
	'deploys',
	'health',
	'jobs',
	'data',
	'security'
];

export type SettingValue = 'always' | 'subscribed' | 'never';

export interface NotificationChannelConfig {
	recipients?: string[];
	urlConfigured?: boolean;
	urlPreview?: string | null;
	secretConfigured?: boolean;
}

export type ChannelHealthState = 'healthy' | 'failing' | 'paused' | 'auto_disabled' | 'disabled';

export interface ChannelHealth {
	state: ChannelHealthState;
	until?: string;
	since?: string;
}

export type ChannelType = 'discord' | 'slack' | 'webhook' | 'email';

export interface NotificationChannel {
	id: string;
	name: string;
	type: ChannelType;
	config: NotificationChannelConfig;
	enabled: boolean;
	ruleCount: number;
	health: ChannelHealth;
	lastDelivery: { status: string; error: string | null; event: string; createdAt: string } | null;
	scopeType: NotificationScopeType;
	scopeId: string | null;
	scopeLabel: string | null;
}

// What a scope may route to. Thinner than the org admin's view on purpose: no
// webhook preview, plus whether this scope owns the destination or inherits it.
export interface ScopedChannel {
	id: string;
	name: string;
	type: ChannelType;
	enabled: boolean;
	scopeType: NotificationScopeType;
	scopeId: string | null;
	own: boolean;
	health: ChannelHealth;
}

export interface ChannelPayload {
	name: string;
	type: string;
	config: { url?: string; recipients?: string[] };
	scopeType?: NotificationScopeType;
	scopeId?: string | null;
}

export interface NotificationRule {
	id: string;
	channelId: string;
	scopeType: NotificationScopeType;
	scopeId: string | null;
	events: string[];
	mode: 'deliver' | 'mute';
	enabled: boolean;
	inherited: boolean;
	channel: { id: string; name: string; type: string; enabled: boolean };
}

export interface RulePayload {
	channelId: string;
	scopeType: NotificationScopeType;
	scopeId: string | null;
	events: string[];
	mode: 'deliver' | 'mute';
}

export interface UserDestination {
	id: string;
	type: 'email' | 'slack' | 'discord';
	config: { urlConfigured?: boolean };
	enabled: boolean;
	consecutiveFailures: number;
	circuitOpenUntil: string | null;
	lastSuccessAt: string | null;
	lastErrorAt: string | null;
	lastError: string | null;
}

export interface UserSettingsOverride {
	scopeType: string;
	scopeId: string;
	values: Partial<Record<NotificationCategory, SettingValue>>;
	label: string;
	context: string | null;
	orgSlug: string | null;
	missing: boolean;
}

export interface ExtensionCategory {
	id: string;
	label: string;
	options: SettingValue[];
	copy: Partial<Record<SettingValue, { label: string; hint: string }>>;
}

export interface UserSettings {
	global: Record<NotificationCategory, SettingValue>;
	defaultValue: SettingValue;
	overrides: UserSettingsOverride[];
	extensionCategories?: ExtensionCategory[];
}

export interface ScopeSettings {
	scope: { scopeType: NotificationScopeType; scopeId: string | null; label: string };
	categories: Record<NotificationCategory, { value: SettingValue; source: string; own: boolean }>;
}

export const EVENT_GROUPS: {
	label: string;
	category: NotificationCategory;
	options: { value: string; label: string; tone: 'ok' | 'fail' }[];
}[] = [
	{
		label: 'Deploys',
		category: 'deploys',
		options: [
			{ value: 'deploy.succeeded', label: 'Succeeded', tone: 'ok' },
			{ value: 'deploy.failed', label: 'Failed', tone: 'fail' }
		]
	},
	{
		label: 'App and database health',
		category: 'health',
		options: [
			{ value: 'pod.crashing', label: 'Crashing', tone: 'fail' },
			{ value: 'pod.recovered', label: 'Recovered', tone: 'ok' },
			{ value: 'alert.firing', label: 'Alert firing', tone: 'fail' },
			{ value: 'alert.resolved', label: 'Alert resolved', tone: 'ok' },
			{ value: 'db.crashing', label: 'Database restarting', tone: 'fail' },
			{ value: 'db.recovered', label: 'Database recovered', tone: 'ok' },
			{ value: 'db.storage_pressure', label: 'Storage running out', tone: 'fail' },
			{ value: 'db.read_only', label: 'Writes paused (disk full)', tone: 'fail' },
			{ value: 'db.writes_resumed', label: 'Writes resumed', tone: 'ok' },
			{ value: 'db.storage_recovered', label: 'Storage recovered', tone: 'ok' }
		]
	},
	{
		label: 'Backups and archiving',
		category: 'data',
		options: [
			{ value: 'backup.completed', label: 'Backup completed', tone: 'ok' },
			{ value: 'backup.failed', label: 'Backup failed', tone: 'fail' },
			{ value: 'db.archiving_failing', label: 'Archiving failing', tone: 'fail' },
			{ value: 'db.archiving_recovered', label: 'Archiving recovered', tone: 'ok' }
		]
	},
	{
		label: 'Jobs',
		category: 'jobs',
		options: [
			{ value: 'job.succeeded', label: 'Succeeded', tone: 'ok' },
			{ value: 'job.failed', label: 'Failed', tone: 'fail' }
		]
	}
];

export const CATEGORY_LABELS: Record<string, string> = {
	deploys: 'Deploys',
	health: 'App and database health',
	jobs: 'Jobs',
	data: 'Backups and archiving',
	security: 'Security'
};

export const SETTING_LABELS: Record<SettingValue, { label: string; hint: string }> = {
	always: { label: 'Everything', hint: 'Every event, whether or not it is yours' },
	subscribed: { label: 'Mine only', hint: 'Builds you triggered and things you own' },
	never: { label: 'Nothing', hint: 'No personal notifications for this' }
};

// Security is about the account rather than about anything the account
// deployed, so "Mine only" has nothing to mean: a sign-in is always yours. Two
// states, and the copy says what they do instead of how much of someone else's
// work you hear about.
export const CATEGORY_OPTIONS: Record<string, SettingValue[]> = {
	deploys: ['always', 'subscribed', 'never'],
	health: ['always', 'subscribed', 'never'],
	jobs: ['always', 'subscribed', 'never'],
	data: ['always', 'subscribed', 'never'],
	security: ['always', 'never']
};

const EXTENSION_COPY: Record<string, ExtensionCategory['copy']> = {};

export function registerExtensionCategories(categories: ExtensionCategory[] | undefined): string[] {
	for (const c of categories ?? []) {
		CATEGORY_LABELS[c.id] = c.label;
		CATEGORY_OPTIONS[c.id] = c.options;
		EXTENSION_COPY[c.id] = c.copy;
	}
	return (categories ?? []).map((c) => c.id);
}

const SECURITY_LABELS: Partial<Record<SettingValue, { label: string; hint: string }>> = {
	always: {
		label: 'On',
		hint: 'Told when something signs in, or when an app is given access to your account'
	},
	never: { label: 'Off', hint: 'No alerts when something signs in to your account' }
};

export function settingLabel(
	category: NotificationCategory,
	value: SettingValue
): { label: string; hint: string } {
	if (category === 'security') return SECURITY_LABELS[value] ?? SETTING_LABELS[value];
	if (EXTENSION_COPY[category]) return EXTENSION_COPY[category][value] ?? SETTING_LABELS[value];
	return SETTING_LABELS[value];
}

const SCOPE_EVENTS: Record<NotificationScopeType, string[] | null> = {
	org: null,
	project: null,
	deployment: [
		'deploy.succeeded',
		'deploy.failed',
		'pod.crashing',
		'pod.recovered',
		'alert.firing',
		'alert.resolved'
	],
	database: [
		'backup.completed',
		'backup.failed',
		'db.archiving_failing',
		'db.archiving_recovered',
		'db.storage_pressure',
		'db.read_only',
		'db.writes_resumed',
		'db.storage_recovered',
		'db.crashing',
		'db.recovered'
	],
	job: ['job.succeeded', 'job.failed']
};

export function eventGroupsForScope(scopeType: NotificationScopeType) {
	const allowed = SCOPE_EVENTS[scopeType];
	if (!allowed) return EVENT_GROUPS;
	return EVENT_GROUPS.map((group) => ({
		...group,
		options: group.options.filter((o) => allowed.includes(o.value))
	})).filter((group) => group.options.length > 0);
}

export function categoriesForScope(scopeType: NotificationScopeType): NotificationCategory[] {
	return eventGroupsForScope(scopeType).map((g) => g.category);
}

export function defaultEventsForScope(scopeType: NotificationScopeType): string[] {
	const preferred = ['deploy.failed', 'pod.crashing', 'backup.failed', 'job.failed'];
	const available = eventGroupsForScope(scopeType).flatMap((g) => g.options.map((o) => o.value));
	const picked = preferred.filter((e) => available.includes(e));
	return picked.length > 0 ? picked : available.slice(0, 1);
}

export function scopeNoun(scopeType: NotificationScopeType): string {
	if (scopeType === 'org') return 'organization';
	if (scopeType === 'deployment') return 'app';
	return scopeType;
}
