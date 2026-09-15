import { RUNTIME_OWNED_ENV_KEYS } from '../env/reserved-env';

/**
 * Dockerfile `ENV` lines, offered as a starting point for a new deployment's
 * env vars. Two kinds are skipped, because carrying them out of the image is
 * always wrong rather than merely unhelpful:
 *
 *   - values containing `$`, which are build-time shell expansions. Nothing
 *     expands them again outside the Dockerfile, so the deployment would store
 *     a literal `$PATH`.
 *   - names the container runtime owns. The image already sets them; a copy in
 *     Orchard only drifts, and it follows the value into the build job.
 *
 * `ENV PATH=/usr/local/bun/bin:$PATH` from a stock bun preamble hit both and
 * took the builder down with it. See env/reserved-env.ts.
 */
export function parseDockerfileEnvVars(
  dockerfileContent: string
): { key: string; value: string }[] {
  const envVars: { key: string; value: string }[] = [];
  const lines = dockerfileContent.split('\n');
  const seenKeys = new Set<string>();
  const carryable = (key: string, value: string) =>
    !RUNTIME_OWNED_ENV_KEYS.has(key) && !value.includes('$');

  const take = (key: string, value: string) => {
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    if (carryable(key, value)) {
      envVars.push({ key, value });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith('ENV ')) continue;

    const rest = trimmed.substring(4).trim();
    const kvMatches = rest.matchAll(
      /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g
    );
    let matched = false;
    for (const m of kvMatches) {
      matched = true;
      const key = m[1];
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      take(key, value);
    }

    if (!matched) {
      const spaceMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
      if (spaceMatch) {
        take(spaceMatch[1], spaceMatch[2].trim());
      }
    }
  }

  return envVars;
}
