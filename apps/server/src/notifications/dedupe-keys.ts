// A dedupe key names the real-world state transition, not the moment we noticed
// it. Two replicas reacting to the same build produce the same key, and the
// unique index on notification_events collapses them to one row. Time buckets
// only appear where no durable id exists for the transition.

const MAX_KEY_LENGTH = 200;

function bucket(ms: number): number {
  return Math.floor(Date.now() / ms);
}

export function deployKey(
  deploymentId: string,
  status: 'succeeded' | 'failed',
  buildRunId: string | null,
  fallbackStamp: number
): string {
  return buildRunId
    ? clamp(`deploy:${buildRunId}:${status}`)
    : clamp(`deploy:${deploymentId}:${status}:${fallbackStamp}`);
}

// The pod informer only calls on an actual transition, so this bucket is a
// backstop against two replicas observing the same transition, not the primary
// guard. Anything shorter than the informer's own debounce would be pointless.
export function podKey(deploymentId: string, state: 'crashing' | 'recovered'): string {
  return clamp(`pod:${deploymentId}:${state}:${bucket(60_000)}`);
}

export function backupKey(backupId: string, status: 'completed' | 'failed'): string {
  return clamp(`backup:${backupId}:${status}`);
}

export function dbArchivingKey(databaseId: string, state: 'failing' | 'recovered'): string {
  return clamp(`dbarch:${databaseId}:${state}:${bucket(300_000)}`);
}

// The sampler holds its own hysteresis, so a transition is already confirmed
// by the time this is asked for. The bucket only guards against a restarted
// replica re-observing pressure it had already reported.
export function dbStorageKey(databaseId: string, state: 'pressure' | 'recovered'): string {
  return clamp(`dbstorage:${databaseId}:${state}:${bucket(6 * 3_600_000)}`);
}

// Same backstop role as podKey: the CNPG informer only calls on a confirmed
// transition, so this catches two replicas seeing the same one.
export function dbStateKey(databaseId: string, state: 'crashing' | 'recovered'): string {
  return clamp(`dbstate:${databaseId}:${state}:${bucket(60_000)}`);
}

export function jobRunKey(runId: string, status: 'succeeded' | 'failed'): string {
  return clamp(`job:${runId}:${status}`);
}

// Replays are deliberately not deduped against the original send: the operator
// asked for them after an outage, so they get their own key space.
export function replayKey(eventId: string, channelId: string, at: number): string {
  return clamp(`replay:${eventId}:${channelId}:${at}`);
}

function clamp(key: string): string {
  return key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key;
}
