/**
 * Distill a failed build's log dump into the few lines a user needs. The full
 * logs already stream into buildLogs; the summary must stay short because the
 * UI surfaces it as the headline failure reason.
 */
export function summarizeBuildFailure(logs?: string | null, pusherLogs?: string | null): string {
  const parts: string[] = [];

  const lintMatch = (logs ?? '').match(/lint violation found for rules: ([A-Za-z0-9, ]+)/);
  if (lintMatch) {
    const rules = lintMatch[1].trim();
    parts.push(
      `Dockerfile lint check failed (${rules}). Your Dockerfile sets "# check=error=true", which turns Dockerfile lint warnings into build failures. Remove that line, or change it to "# check=skip=${rules.replace(/,\s*/g, ',')}" to skip these rules.`,
    );
  }

  const lines = (logs ?? '').split('\n');
  const solveError = lines.filter((l) => l.startsWith('error: failed to solve:')).pop();
  const stepErrors = lines.filter((l) => /^#\d+ ERROR:/.test(l)).slice(-2);
  parts.push(...stepErrors);

  // The "#N ERROR: process ... exit code: 1" line says a step failed, never why.
  // The why is in that step's own output, a few lines above it, and it was being
  // dropped: a user saw "pnpm run build did not complete successfully" with no
  // mention of the Vite error that actually broke the build. Carry the tail of
  // the failing step's output so the headline says the cause.
  const failingStep = stepErrors[stepErrors.length - 1]?.match(/^#(\d+) ERROR:/)?.[1];
  if (failingStep) {
    const prefix = new RegExp(`^#${failingStep} (?:\\d+\\.\\d+ )?`);
    const own = lines
      .filter((l) => prefix.test(l) && !/^#\d+ ERROR:/.test(l))
      .map((l) => l.replace(prefix, '').trimEnd())
      .filter((l) => l.trim().length > 0);
    parts.push(...own.slice(-6));
  }

  if (solveError && !stepErrors.some((e) => solveError.includes(e.replace(/^#\d+ ERROR: /, '')))) {
    parts.push(solveError);
  }

  const reasonsMatch = (logs ?? '').match(
    /Build job failed with the following reasons:\n([\s\S]*?)(?:\n\n|$)/,
  );
  if (reasonsMatch) {
    parts.push(
      ...reasonsMatch[1].split('\n').filter((l) => l.trim() && !/ - No message$/.test(l)),
    );
  }

  const pusherError = (pusherLogs ?? '')
    .split('\n')
    .filter((l) => /^(FATA|Error)\b|level=fatal/.test(l))
    .pop();
  if (pusherError) parts.push(`Pusher: ${pusherError}`);

  if (parts.length === 0) {
    const tail = lines.filter((l) => l.trim() && !l.startsWith('time=')).slice(-4);
    parts.push(...tail);
  }

  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    const key = p.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.join('\n').slice(0, 800);
}
