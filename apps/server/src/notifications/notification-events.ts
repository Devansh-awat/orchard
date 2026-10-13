const CORE_NOTIFICATION_EVENTS = [
  'deploy.succeeded',
  'deploy.failed',
  'pod.crashing',
  'pod.recovered',
  'alert.firing',
  'alert.resolved',
  'backup.completed',
  'backup.failed',
  'db.archiving_failing',
  'db.archiving_recovered',
  'db.storage_pressure',
  'db.storage_recovered',
  'db.read_only',
  'db.writes_resumed',
  'db.crashing',
  'db.recovered',
  'job.succeeded',
  'job.failed',
  'security.signed_in',
  'security.app_authorized'
] as const;

export type NotificationEventName = (typeof CORE_NOTIFICATION_EVENTS)[number] | `${string}.${string}`;

export const NOTIFICATION_EVENTS: NotificationEventName[] = [...CORE_NOTIFICATION_EVENTS];

export const NOTIFICATION_CHANNEL_TYPES = ['discord', 'slack', 'webhook', 'email'] as const;

export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export const USER_DESTINATION_TYPES = ['email', 'slack', 'discord'] as const;

export type UserDestinationType = (typeof USER_DESTINATION_TYPES)[number];

// Rules address raw events (power); people address categories (simplicity).
// Keeping the personal lane small is the single biggest reason Sentry's
// notification settings stay legible, so resist growing this list. Security is
// the one addition that earns its place: it is the only category about the
// account rather than about something the account deployed, and an alert nobody
// asked for is the entire point of it.
const CORE_NOTIFICATION_CATEGORIES = ['deploys', 'health', 'jobs', 'data', 'security'] as const;

export type NotificationCategory = (typeof CORE_NOTIFICATION_CATEGORIES)[number] | (string & {});

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [...CORE_NOTIFICATION_CATEGORIES];

export const EVENT_CATEGORY: Record<string, NotificationCategory> = {
  'deploy.succeeded': 'deploys',
  'deploy.failed': 'deploys',
  'pod.crashing': 'health',
  'pod.recovered': 'health',
  'alert.firing': 'health',
  'alert.resolved': 'health',
  'backup.completed': 'data',
  'backup.failed': 'data',
  'db.archiving_failing': 'data',
  'db.archiving_recovered': 'data',
  'db.storage_pressure': 'health',
  'db.storage_recovered': 'health',
  'db.read_only': 'health',
  'db.writes_resumed': 'health',
  'db.crashing': 'health',
  'db.recovered': 'health',
  'job.succeeded': 'jobs',
  'job.failed': 'jobs',
  'security.signed_in': 'security',
  'security.app_authorized': 'security'
};

export const CATEGORY_LABELS: Record<string, string> = {
  deploys: 'Deploys',
  health: 'App and database health',
  jobs: 'Jobs',
  data: 'Backups and archiving',
  security: 'Security'
};

// Scopes a rule or a personal setting can attach to. 'global' is personal-only
// (a user's account-wide default); 'org' is the broadest shared scope.
export const RULE_SCOPE_TYPES = ['org', 'project', 'deployment', 'database', 'job'] as const;

export type RuleScopeType = (typeof RULE_SCOPE_TYPES)[number];

export const SETTING_SCOPE_TYPES = ['global', ...RULE_SCOPE_TYPES] as const;

export type SettingScopeType = (typeof SETTING_SCOPE_TYPES)[number];

export type ResourceScopeType = 'deployment' | 'database' | 'job' | 'user';

export const EVENT_RESOURCE_SCOPE: Record<string, ResourceScopeType> = {
  'deploy.succeeded': 'deployment',
  'deploy.failed': 'deployment',
  'pod.crashing': 'deployment',
  'pod.recovered': 'deployment',
  'alert.firing': 'deployment',
  'alert.resolved': 'deployment',
  'backup.completed': 'database',
  'backup.failed': 'database',
  'db.archiving_failing': 'database',
  'db.archiving_recovered': 'database',
  'db.storage_pressure': 'database',
  'db.storage_recovered': 'database',
  'db.read_only': 'database',
  'db.writes_resumed': 'database',
  'db.crashing': 'database',
  'db.recovered': 'database',
  'job.succeeded': 'job',
  'job.failed': 'job',
  'security.signed_in': 'user',
  'security.app_authorized': 'user'
};

// A security event is about one person's account and never belongs on a shared
// channel, so it is not offerable to a rule at any scope. Team rules address
// org resources; this one addresses you.
export function teamRoutableEvents(): NotificationEventName[] {
  return NOTIFICATION_EVENTS.filter((e) => EVENT_RESOURCE_SCOPE[e] !== 'user');
}

export function eventsForScopeType(scopeType: RuleScopeType): NotificationEventName[] {
  if (scopeType === 'org' || scopeType === 'project') return teamRoutableEvents();
  return teamRoutableEvents().filter((e) => EVENT_RESOURCE_SCOPE[e] === scopeType);
}

// always: everything in this category. subscribed: only what I'm involved in
// (I triggered the build, I created the deployment, I own the project).
// never: nothing. Absent rows inherit the next broader scope.
export const SETTING_VALUES = ['always', 'subscribed', 'never'] as const;

export type SettingValue = (typeof SETTING_VALUES)[number];

export const DEFAULT_SETTING_VALUE: SettingValue = 'subscribed';

// Security ships on. 'subscribed' would deliver too, since you are always
// involved in your own sign-in, but it would read as "Mine only" in the UI and
// a sign-in cannot be anything else. The alert nobody asked for is the point of
// the category, so the default says so out loud.
export const CATEGORY_DEFAULT_VALUE: Record<string, SettingValue> = {
  deploys: DEFAULT_SETTING_VALUE,
  health: DEFAULT_SETTING_VALUE,
  jobs: DEFAULT_SETTING_VALUE,
  data: DEFAULT_SETTING_VALUE,
  security: 'always'
};

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

export type EventTone = 'success' | 'failure' | 'notice';

export const EVENT_TONE: Record<string, EventTone> = {
  'deploy.succeeded': 'success',
  'deploy.failed': 'failure',
  'pod.crashing': 'failure',
  'pod.recovered': 'success',
  'alert.firing': 'failure',
  'alert.resolved': 'success',
  'backup.completed': 'success',
  'backup.failed': 'failure',
  'db.archiving_failing': 'failure',
  'db.archiving_recovered': 'success',
  'db.storage_pressure': 'failure',
  'db.storage_recovered': 'success',
  'db.read_only': 'failure',
  'db.writes_resumed': 'success',
  'db.crashing': 'failure',
  'db.recovered': 'success',
  'job.succeeded': 'success',
  'job.failed': 'failure',
  // Not success and not failure: a sign-in alert is something to read, and
  // painting it green says "all good" about the one message whose whole job is
  // to make you look twice.
  'security.signed_in': 'notice',
  'security.app_authorized': 'notice'
};

export const TONE_COLORS: Record<EventTone, number> = {
  success: 0x22c55e,
  failure: 0xef4444,
  notice: 0x3b82f6
};

export function isNotificationEvent(value: unknown): value is NotificationEventName {
  return typeof value === 'string' && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export type CategoryChoiceCopy = Partial<Record<SettingValue, { label: string; hint: string }>>;

export type ExtensionCategory = {
  id: string;
  label: string;
  options: SettingValue[];
  copy: CategoryChoiceCopy;
};

export const EXTENSION_CATEGORIES: ExtensionCategory[] = [];

export type NotificationEventDefinition = {
  event: `${string}.${string}`;
  category: string;
  categoryLabel?: string;
  categoryDefault?: SettingValue;
  categoryOptions?: SettingValue[];
  categoryCopy?: CategoryChoiceCopy;
  scope: ResourceScopeType;
  tone: EventTone;
};

export function registerNotificationEvent(def: NotificationEventDefinition): void {
  if (!NOTIFICATION_EVENTS.includes(def.event)) NOTIFICATION_EVENTS.push(def.event);
  EVENT_CATEGORY[def.event] = def.category;
  EVENT_RESOURCE_SCOPE[def.event] = def.scope;
  EVENT_TONE[def.event] = def.tone;
  if (!NOTIFICATION_CATEGORIES.includes(def.category)) {
    NOTIFICATION_CATEGORIES.push(def.category);
    CATEGORY_LABELS[def.category] = def.categoryLabel ?? def.category;
    CATEGORY_DEFAULT_VALUE[def.category] = def.categoryDefault ?? DEFAULT_SETTING_VALUE;
    EXTENSION_CATEGORIES.push({
      id: def.category,
      label: def.categoryLabel ?? def.category,
      options: def.categoryOptions ?? [...SETTING_VALUES],
      copy: def.categoryCopy ?? {}
    });
  }
}
