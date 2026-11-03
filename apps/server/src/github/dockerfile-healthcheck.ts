/**
 * The `HEALTHCHECK` a Dockerfile declares, read so Orchard can probe an app
 * the way its author already said it should be probed.
 *
 * Only the stage that actually gets built counts: a `HEALTHCHECK` in a builder
 * stage never reaches the image, and one in a stage the final image is `FROM`
 * is inherited. Both rules are Docker's, and getting them wrong means probing
 * with a command the container does not have.
 *
 * `HEALTHCHECK NONE` cancels an inherited check, which is a statement that the
 * image has none: the caller falls back to whatever Orchard is configured
 * with, rather than to a command that was explicitly withdrawn.
 */
export interface DockerfileHealthCheck {
  command: string[];
  interval?: number;
  timeout?: number;
  retries?: number;
  startPeriod?: number;
}

const DEFAULT_STAGE = '';

function logicalLines(dockerfileContent: string): string[] {
  const lines: string[] = [];
  let pending = '';

  for (const raw of dockerfileContent.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    // Docker strips a comment or blank line with its newline wherever it sits,
    // including between the halves of a continued instruction.
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (trimmed.endsWith('\\')) {
      pending += `${trimmed.slice(0, -1)} `;
      continue;
    }

    lines.push(`${pending}${trimmed}`.trim());
    pending = '';
  }

  if (pending.trim()) lines.push(pending.trim());

  return lines;
}

function parseDuration(value: string): number | undefined {
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)];
  if (matches.length === 0) return undefined;

  const scale: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600
  };

  let seconds = 0;
  for (const match of matches) {
    seconds += parseFloat(match[1]) * scale[match[2]];
  }

  const rounded = Math.round(seconds);
  return rounded > 0 ? rounded : 1;
}

function parseExecForm(value: string): string[] | null {
  if (!value.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== 'string')) return null;
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function parseInstruction(rest: string): DockerfileHealthCheck | null {
  const check: DockerfileHealthCheck = { command: [] };
  let remainder = rest;

  while (remainder.startsWith('--')) {
    const match = remainder.match(/^--([a-zA-Z-]+)=(\S+)\s*/);
    if (!match) return null;
    const [, flag, value] = match;
    remainder = remainder.slice(match[0].length);

    if (flag === 'interval') check.interval = parseDuration(value);
    else if (flag === 'timeout') check.timeout = parseDuration(value);
    else if (flag === 'start-period') check.startPeriod = parseDuration(value);
    else if (flag === 'retries') {
      const retries = parseInt(value, 10);
      if (Number.isFinite(retries) && retries > 0) check.retries = retries;
    }
  }

  const cmd = remainder.match(/^CMD\s+(.+)$/i);
  if (!cmd) return null;

  const argv = cmd[1].trim();
  // Shell form runs through `/bin/sh -c`, which is the only way `curl ... ||
  // exit 1` (the form nearly every Dockerfile uses) means anything.
  check.command = parseExecForm(argv) ?? ['/bin/sh', '-c', argv];

  return check;
}

function stageName(fromArgs: string): { name: string; parent: string } {
  const parts = fromArgs.split(/\s+/).filter(Boolean);
  const asIndex = parts.findIndex((part) => part.toUpperCase() === 'AS');
  const parent = parts.find((part) => !part.startsWith('--')) ?? '';
  return {
    name: asIndex > 0 ? (parts[asIndex + 1] ?? DEFAULT_STAGE).toLowerCase() : DEFAULT_STAGE,
    parent: parent.toLowerCase()
  };
}

export function parseDockerfileHealthCheck(
  dockerfileContent: string,
  target?: string | null
): DockerfileHealthCheck | null {
  const byStage = new Map<string, DockerfileHealthCheck | null>();
  let current: DockerfileHealthCheck | null = null;
  let currentStage = DEFAULT_STAGE;
  let started = false;

  const closeStage = () => {
    if (started) byStage.set(currentStage, current);
  };

  for (const line of logicalLines(dockerfileContent)) {
    const instruction = line.match(/^([A-Za-z]+)\s+(.*)$/);
    if (!instruction) continue;
    const keyword = instruction[1].toUpperCase();

    if (keyword === 'FROM') {
      closeStage();
      const { name, parent } = stageName(instruction[2]);
      started = true;
      currentStage = name;
      current = byStage.get(parent) ?? null;
      continue;
    }

    if (keyword !== 'HEALTHCHECK') continue;

    const rest = instruction[2].trim();
    current = rest.toUpperCase() === 'NONE' ? null : (parseInstruction(rest) ?? current);
  }

  closeStage();

  if (target) {
    const wanted = byStage.get(target.toLowerCase());
    return wanted ?? null;
  }

  return current;
}
