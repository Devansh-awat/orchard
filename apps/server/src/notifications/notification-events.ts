export const NOTIFICATION_EVENTS = [
  'deploy.succeeded',
  'deploy.failed',
  'pod.crashing',
  'pod.recovered',
  'backup.completed',
  'backup.failed',
  'db.archiving_failing',
  'db.archiving_recovered',
  'job.succeeded',
  'job.failed',
] as const;

export type NotificationEventName = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CHANNEL_TYPES = ['discord', 'slack', 'webhook', 'email'] as const;

export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export const USER_DESTINATION_TYPES = ['email', 'slack', 'discord'] as const;

export type UserDestinationType = (typeof USER_DESTINATION_TYPES)[number];

// Rules address raw events (power); people address categories (simplicity).
// Keeping the personal lane at four buckets is the single biggest reason
// Sentry's notification settings stay legible, so resist growing this list.
export const NOTIFICATION_CATEGORIES = ['deploys', 'health', 'jobs', 'data'] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const EVENT_CATEGORY: Record<NotificationEventName, NotificationCategory> = {
  'deploy.succeeded': 'deploys',
  'deploy.failed': 'deploys',
  'pod.crashing': 'health',
  'pod.recovered': 'health',
  'backup.completed': 'data',
  'backup.failed': 'data',
  'db.archiving_failing': 'data',
  'db.archiving_recovered': 'data',
  'job.succeeded': 'jobs',
  'job.failed': 'jobs',
};

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  deploys: 'Deploys',
  health: 'App health',
  jobs: 'Jobs',
  data: 'Databases and backups',
};

// Scopes a rule or a personal setting can attach to. 'global' is personal-only
// (a user's account-wide default); 'org' is the broadest shared scope.
export const RULE_SCOPE_TYPES = ['org', 'project', 'deployment', 'database', 'job'] as const;

export type RuleScopeType = (typeof RULE_SCOPE_TYPES)[number];

export const SETTING_SCOPE_TYPES = ['global', ...RULE_SCOPE_TYPES] as const;

export type SettingScopeType = (typeof SETTING_SCOPE_TYPES)[number];

export type ResourceScopeType = 'deployment' | 'database' | 'job';

export const EVENT_RESOURCE_SCOPE: Record<NotificationEventName, ResourceScopeType> = {
  'deploy.succeeded': 'deployment',
  'deploy.failed': 'deployment',
  'pod.crashing': 'deployment',
  'pod.recovered': 'deployment',
  'backup.completed': 'database',
  'backup.failed': 'database',
  'db.archiving_failing': 'database',
  'db.archiving_recovered': 'database',
  'job.succeeded': 'job',
  'job.failed': 'job',
};

export function eventsForScopeType(scopeType: RuleScopeType): NotificationEventName[] {
  if (scopeType === 'org' || scopeType === 'project') return [...NOTIFICATION_EVENTS];
  return NOTIFICATION_EVENTS.filter((e) => EVENT_RESOURCE_SCOPE[e] === scopeType);
}

// always: everything in this category. subscribed: only what I'm involved in
// (I triggered the build, I created the deployment, I own the project).
// never: nothing. Absent rows inherit the next broader scope.
export const SETTING_VALUES = ['always', 'subscribed', 'never'] as const;

export type SettingValue = (typeof SETTING_VALUES)[number];

export const DEFAULT_SETTING_VALUE: SettingValue = 'subscribed';

// The scope_id stored for an account-wide preference. A real id is never this
// value, and it keeps the column non-null so the unique index actually holds.
export const GLOBAL_SCOPE_ID = 'global';

export interface NotificationMessage {
  event: NotificationEventName;
  title: string;
  body: string;
  url?: string;
  projectId?: string;
  projectName?: string;
  targetId?: string;
  targetName?: string;
  fields?: { name: string; value: string }[];
}

export const EVENT_TONE: Record<NotificationEventName, 'success' | 'failure'> = {
  'deploy.succeeded': 'success',
  'deploy.failed': 'failure',
  'pod.crashing': 'failure',
  'pod.recovered': 'success',
  'backup.completed': 'success',
  'backup.failed': 'failure',
  'db.archiving_failing': 'failure',
  'db.archiving_recovered': 'success',
  'job.succeeded': 'success',
  'job.failed': 'failure',
};

export const TONE_COLORS: Record<'success' | 'failure', number> = {
  success: 0x22c55e,
  failure: 0xef4444,
};

export function isNotificationEvent(value: unknown): value is NotificationEventName {
  return typeof value === 'string' && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}
