import * as k8s from '@kubernetes/client-node';

export const ANNOTATION_APPLIED_SCHEDULE = 'orchard/applied-schedule';

export const RECREATE_MISSING_AFTER_MS = 10 * 60 * 1000;

const ORCHARD_KEY_PREFIX = 'orchard/';

export type MissingCronJobAction = 'skip' | 'unlink' | 'wait' | 'create';

export function missingCronJobAction(input: {
  enabled: boolean;
  linked: boolean;
  recreate: boolean;
  engineWatching: boolean;
  missingForMs: number;
}): MissingCronJobAction {
  if (!input.enabled) return input.linked ? 'unlink' : 'skip';
  if (
    input.linked &&
    !input.recreate &&
    input.engineWatching &&
    input.missingForMs < RECREATE_MISSING_AFTER_MS
  ) {
    return 'wait';
  }
  return 'create';
}

export const SCHEDULE_FIELDS = ['schedule', 'timeZone', 'suspend', 'concurrencyPolicy'] as const;

export type ScheduleField = (typeof SCHEDULE_FIELDS)[number];

export interface ScheduleState {
  schedule: string | null;
  timeZone: string | null;
  suspend: boolean;
  concurrencyPolicy: string;
}

export function scheduleStateOf(spec: k8s.V1CronJobSpec | undefined): ScheduleState {
  return {
    schedule: spec?.schedule ?? null,
    timeZone: spec?.timeZone || null,
    suspend: spec?.suspend ?? false,
    concurrencyPolicy: spec?.concurrencyPolicy ?? 'Allow'
  };
}

export function jobScheduleState(job: {
  scheduleCron: string | null;
  timeZone: string | null;
  enabled: boolean;
  concurrencyPolicy: string;
}): ScheduleState {
  return {
    schedule: job.scheduleCron,
    timeZone: job.timeZone || null,
    suspend: !job.enabled,
    concurrencyPolicy: job.concurrencyPolicy === 'allow' ? 'Allow' : 'Forbid'
  };
}

export function appliedScheduleAnnotation(state: ScheduleState): string {
  return JSON.stringify(state);
}

export function readAppliedSchedule(meta: k8s.V1ObjectMeta | undefined): ScheduleState | null {
  const raw = meta?.annotations?.[ANNOTATION_APPLIED_SCHEDULE];
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed?.suspend !== 'boolean' || typeof parsed?.concurrencyPolicy !== 'string') {
    return null;
  }
  return {
    schedule: typeof parsed.schedule === 'string' ? parsed.schedule : null,
    timeZone: typeof parsed.timeZone === 'string' && parsed.timeZone ? parsed.timeZone : null,
    suspend: parsed.suspend,
    concurrencyPolicy: parsed.concurrencyPolicy
  };
}

export function externalScheduleEdits(
  live: ScheduleState,
  applied: ScheduleState,
  stored: ScheduleState
): ScheduleField[] {
  return SCHEDULE_FIELDS.filter(
    (field) => live[field] !== applied[field] && stored[field] === applied[field]
  );
}

function carryOver(spec: k8s.V1CronJobSpec, field: ScheduleField, live: ScheduleState) {
  if (field === 'schedule') {
    if (live.schedule) spec.schedule = live.schedule;
  } else if (field === 'timeZone') {
    if (live.timeZone) spec.timeZone = live.timeZone;
    else delete spec.timeZone;
  } else if (field === 'suspend') {
    spec.suspend = live.suspend;
  } else {
    spec.concurrencyPolicy = live.concurrencyPolicy;
  }
}

function foreignKeys(map: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map ?? {}).filter(([key]) => !key.startsWith(ORCHARD_KEY_PREFIX))
  );
}

export function cronJobForReplace(desired: k8s.V1CronJob, live: k8s.V1CronJob): k8s.V1CronJob {
  const spec = { ...desired.spec! };
  const applied = readAppliedSchedule(live.metadata);
  if (applied) {
    const current = scheduleStateOf(live.spec);
    for (const field of externalScheduleEdits(current, applied, scheduleStateOf(desired.spec))) {
      carryOver(spec, field, current);
    }
  }
  return {
    ...desired,
    metadata: {
      ...desired.metadata,
      labels: { ...foreignKeys(live.metadata?.labels), ...desired.metadata?.labels },
      annotations: {
        ...foreignKeys(live.metadata?.annotations),
        ...desired.metadata?.annotations
      },
      resourceVersion: live.metadata?.resourceVersion
    },
    spec
  };
}
