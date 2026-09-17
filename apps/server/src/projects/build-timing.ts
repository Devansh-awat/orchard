/**
 * When a build is triggered its `buildStepTimestamps` blob is replaced with a
 * fresh `{ __start }` (epoch ms) and every step merges into it from there, so
 * `__start` is the one timestamp that holds still for the length of a build.
 * `updatedAt` looks like a start time and is not: every log flush and step
 * transition bumps it, so an elapsed counter measured from it restarts every
 * couple of seconds.
 */
export function buildStartedAtFrom(timestamps: unknown): Date | null {
  const start = (timestamps as Record<string, unknown> | null)?.__start;
  if (typeof start !== 'number' || !Number.isFinite(start) || start <= 0) return null;
  const date = new Date(start);
  return Number.isNaN(date.getTime()) ? null : date;
}
