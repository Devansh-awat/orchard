import { describeAudit, describeAuditMetadata } from './timeline-entries';

export type ChangeKind =
  | 'deploy'
  | 'rollback'
  | 'build'
  | 'config'
  | 'env'
  | 'resources'
  | 'scale'
  | 'domain'
  | 'restart'
  | 'eviction'
  | 'preemption'
  | 'scheduling'
  | 'probe'
  | 'volume'
  | 'node';

export type ChangeTone = 'deploy' | 'config' | 'platform' | 'error';

export interface ChangeActor {
  id: string;
  name: string;
}

export interface ChangeEntry {
  id: string;
  t: number;
  kind: ChangeKind;
  tone: ChangeTone;
  label: string;
  detail: string | null;
  cause: string | null;
  actor: ChangeActor | null;
}

const TONES: Record<ChangeKind, ChangeTone> = {
  deploy: 'deploy',
  rollback: 'deploy',
  build: 'error',
  config: 'config',
  env: 'config',
  resources: 'config',
  scale: 'config',
  domain: 'config',
  restart: 'config',
  eviction: 'platform',
  preemption: 'platform',
  scheduling: 'platform',
  probe: 'error',
  volume: 'platform',
  node: 'platform'
};

const AUDIT_KINDS: [RegExp, ChangeKind][] = [
  [/^deployment\.rolled_back$/, 'rollback'],
  [/^deployment\.env\./, 'env'],
  [/^deployment\.resources\./, 'resources'],
  [/^deployment\.scaled$/, 'scale'],
  [/^deployment\.(restarted|started|stopped)$/, 'restart'],
  [/^(ingress|service\.port)\./, 'domain'],
  [
    /^deployment\.(image|strategy|pull_policy|placement|disruption_budget|health_check|build_options|volumes|github_repo|autodeploy)\./,
    'config'
  ]
];

const IGNORED_AUDIT = new Set([
  'deployment.redeployed',
  'deployment.created',
  'deployment.webhook_triggered',
  'deployment.push_held',
  'deployment.build_cancelled'
]);

export function auditChangeKind(action: string): ChangeKind | null {
  if (IGNORED_AUDIT.has(action)) return null;
  for (const [re, kind] of AUDIT_KINDS) if (re.test(action)) return kind;
  if (action.startsWith('deployment.') || action.startsWith('webhook_token.')) return null;
  return null;
}

export function toneOf(kind: ChangeKind): ChangeTone {
  return TONES[kind];
}

const TIMESTAMP_TAG = /^v\d{9,}$/;

export function versionLabel(h: { tag: string | null; commitSha: string | null }): string {
  if (h.tag && !TIMESTAMP_TAG.test(h.tag)) return h.tag;
  if (h.commitSha) return h.commitSha.slice(0, 7);
  return h.tag ?? 'new version';
}

function changedKeys(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const m = metadata as Record<string, unknown>;
  return ['changed', 'added', 'removed']
    .flatMap((k) => (typeof m[k] === 'string' ? (m[k] as string).split(',') : []))
    .map((k) => k.trim())
    .filter(Boolean);
}

function moved(metadata: unknown, key: string): boolean {
  const v = (metadata as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) && v.length === 2 && v[0] !== v[1];
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function auditCause(
  kind: ChangeKind,
  row: { action: string; targetLabel: string | null; metadata: unknown },
  title: string
): string {
  switch (kind) {
    case 'resources': {
      const cpu = moved(row.metadata, 'cpuMilli');
      const mem = moved(row.metadata, 'memoryBytes');
      if (cpu && mem) return 'the CPU and memory limits changed';
      if (cpu) return 'the CPU limit changed';
      return 'the memory limit changed';
    }
    case 'env': {
      const keys = changedKeys(row.metadata);
      if (keys.length === 1) return `${keys[0]} changed`;
      if (keys.length > 1) return `${keys.length} environment variables changed`;
      return 'the environment variables changed';
    }
    case 'scale': {
      const r = (row.metadata as Record<string, unknown> | null)?.replicas;
      const to = Array.isArray(r) ? r[1] : r;
      return typeof to === 'number' ? `the app was scaled to ${to}` : 'the app was scaled';
    }
    case 'restart':
      return row.action === 'deployment.stopped' ? 'the app was stopped' : 'the app was restarted';
    case 'rollback':
      return 'the app was rolled back';
    case 'domain':
      return row.targetLabel ? `${row.targetLabel} changed` : 'a domain changed';
    default:
      return `the ${lowerFirst(title).replace(/ (changed|updated)$/, '')} changed`;
  }
}

export function auditChange(row: {
  id: string;
  action: string;
  createdAt: Date;
  targetType: string | null;
  targetLabel: string | null;
  metadata: unknown;
}): Omit<ChangeEntry, 'actor'> | null {
  const kind = auditChangeKind(row.action);
  if (!kind) return null;
  const described = describeAudit(row);
  return {
    id: `audit:${row.id}`,
    t: row.createdAt.getTime(),
    kind,
    tone: toneOf(kind),
    label: described.title,
    detail: described.detail ?? describeAuditMetadata(row.metadata),
    cause: auditCause(kind, row, described.title)
  };
}

const EVENT_KINDS: Record<string, ChangeKind> = {
  eviction: 'eviction',
  preemption: 'preemption',
  scheduling: 'scheduling',
  killing: 'probe',
  volume: 'volume',
  node: 'node'
};

const EVENT_LABELS: Record<string, string> = {
  Evicted: 'Pod evicted',
  TaintManagerEviction: 'Pod evicted from its node',
  Preempted: 'Pod preempted',
  Preempting: 'Pod preempted',
  FailedScheduling: 'Pod could not be scheduled',
  NodeNotReady: 'Node not ready',
  FailedMount: 'Volume failed to mount',
  FailedAttachVolume: 'Volume failed to attach',
  Killing: 'Killed by a failing probe',
  Cordoned: 'Node cordoned',
  Uncordoned: 'Node uncordoned',
  MemoryPressure: 'Node low on memory',
  DiskPressure: 'Node low on disk',
  PIDPressure: 'Node out of process ids',
  NodeUnreachable: 'Node unreachable'
};

const NODE_CAUSES: Record<string, string> = {
  Cordoned: 'was cordoned',
  Uncordoned: 'was uncordoned',
  MemoryPressure: 'ran low on memory',
  DiskPressure: 'ran low on disk',
  PIDPressure: 'ran out of process ids',
  NodeNotReady: 'stopped reporting ready',
  NodeUnreachable: 'became unreachable'
};

const EVENT_CAUSES: Record<string, string> = {
  eviction: 'a pod was evicted',
  preemption: 'a pod was preempted',
  scheduling: 'a pod could not be scheduled',
  killing: 'a failing probe killed a pod',
  volume: 'a volume failed to mount'
};

export function clusterEventChange(row: {
  id: string;
  kind: string;
  reason: string;
  message: string | null;
  nodeName: string | null;
  count: number;
  at: Date;
}): Omit<ChangeEntry, 'actor'> {
  const kind = EVENT_KINDS[row.kind] ?? 'node';
  const label = EVENT_LABELS[row.reason] ?? row.reason;
  const repeated = row.count > 1 ? `${row.count} times` : null;
  const detail = [
    row.message,
    row.nodeName && row.kind !== 'node' ? `on ${row.nodeName}` : null,
    repeated
  ]
    .filter(Boolean)
    .join(' · ');
  const cause =
    row.kind === 'node'
      ? `the node${row.nodeName ? ` ${row.nodeName}` : ''} ${NODE_CAUSES[row.reason] ?? 'had a problem'}`
      : (EVENT_CAUSES[row.kind] ?? label.toLowerCase());
  return {
    id: `cluster:${row.id}`,
    t: row.at.getTime(),
    kind,
    tone: toneOf(kind),
    label,
    detail: detail ? detail.slice(0, 240) : null,
    cause
  };
}

export function releaseChange(row: {
  id: string;
  promotedAt: Date;
  status: string;
  reason: string | null;
  imageHistory: {
    tag: string | null;
    commitSha: string | null;
    commitMessage: string | null;
  } | null;
  image: string;
}): Omit<ChangeEntry, 'actor'> {
  const version = row.imageHistory
    ? versionLabel(row.imageHistory)
    : (row.image.split(':').pop() ?? row.image);
  const rolledBack = row.status === 'rolled_back' || /^rolled? ?back/i.test(row.reason ?? '');
  const commit = row.imageHistory?.commitMessage?.split('\n')[0].trim() || null;
  return {
    id: `release:${row.id}`,
    t: row.promotedAt.getTime(),
    kind: rolledBack ? 'rollback' : 'deploy',
    tone: 'deploy',
    label: rolledBack ? `Rolled back to ${version}` : `${version} went live`,
    detail: commit ? commit.slice(0, 240) : null,
    cause: rolledBack ? `the rollback to ${version}` : `${version} went live`
  };
}

export function buildChange(row: {
  id: string;
  status: string;
  createdAt: Date;
  detail: string | null;
  commitMessage: string | null;
}): Omit<ChangeEntry, 'actor'> | null {
  if (row.status !== 'failed') return null;
  const reason = row.detail?.split('\n')[0].trim() || row.commitMessage?.split('\n')[0].trim();
  return {
    id: `build:${row.id}`,
    t: row.createdAt.getTime(),
    kind: 'build',
    tone: 'error',
    label: 'Build failed',
    detail: reason ? reason.slice(0, 240) : null,
    cause: null
  };
}

export function mergeChanges(lists: ChangeEntry[][], limit: number): ChangeEntry[] {
  return lists
    .flat()
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1))
    .slice(-limit);
}
