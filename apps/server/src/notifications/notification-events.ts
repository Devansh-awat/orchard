export const NOTIFICATION_EVENTS = [
  'deploy.succeeded',
  'deploy.failed',
  'pod.crashing',
  'pod.recovered',
  'backup.completed',
  'backup.failed',
  'job.succeeded',
  'job.failed',
] as const;

export type NotificationEventName = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CHANNEL_TYPES = ['discord', 'slack', 'webhook', 'email'] as const;

export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

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
  'job.succeeded': 'success',
  'job.failed': 'failure',
};

export const TONE_COLORS: Record<'success' | 'failure', number> = {
  success: 0x22c55e,
  failure: 0xef4444,
};
