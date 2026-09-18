/**
 * A deployment's start command, resolved to the argv its container runs.
 *
 * Applied as the pod's `args`, never its `command`. containerd resolves args
 * against the image config before the runtime sees anything, so args land
 * after the image's ENTRYPOINT: a wrapper entrypoint that ends in `exec "$@"`
 * still performs its setup and the override behaves exactly like
 * `docker run <image> <command>`. Overriding `command` would discard that
 * setup, which is how a Rails image loses its jemalloc preload.
 *
 * This is the only lever for a Dockerfile-built or image-source deployment:
 * for those, `startCommand` is never seen by a builder, so it has to take
 * effect at the pod spec or not at all. A `railpack` build keeps its existing
 * build-time meaning (RAILPACK_START_CMD, baked into the image) and never
 * reaches here.
 */

/** Operators that splitting on whitespace would destroy or leave unexpanded. */
const SHELL_OPERATORS = /[|&;<>$`*\n()]/;

const SHELLS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh']);

function parseExecForm(command: string): string[] | null {
  if (!command.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(command);
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== 'string')) return null;
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Split on whitespace, honouring quotes the way a POSIX shell would, so
 * `npm run start -- --name "my app"` keeps its argument in one piece.
 * Returns null on an unterminated quote, leaving the caller to hand the string
 * to a shell that can report the error itself.
 */
function tokenize(command: string): string[] | null {
  const argv: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command[i + 1];
        i += 1;
      } else if (char === '"') quote = null;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (char === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      started = true;
      i += 1;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) return null;
  if (started) argv.push(current);
  return argv;
}

/** `sh -c '...'` and friends: the user asked for a shell, so believe them. */
function isExplicitShell(argv: string[]): boolean {
  const binary = (argv[0] ?? '').split('/').pop() ?? '';
  return SHELLS.has(binary) && argv.includes('-c');
}

/**
 * Resolve a stored start command to container args, or null for "leave the
 * image's own CMD alone".
 *
 * A command carrying shell operators goes through `/bin/sh -c` because there
 * is no argv that means `a && b`. Everything else is split into argv and
 * exec'd directly, so the app is PID 1 and receives the SIGTERM a rollout
 * sends. Behind a shell that only mostly holds: `sh -c 'a && b'` tail-execs
 * `b`, so it is still PID 1 and still signalled, but `sh -c 'a | b'` leaves
 * the app at PID 2, where it is torn down when the shell exits without ever
 * being told to stop — no connection draining, no finishing the job in hand.
 * Measured under gVisor, which is what tenant pods run.
 */
export function resolveStartArgs(raw: string | null | undefined): string[] | null {
  const command = (raw ?? '').trim();
  if (!command) return null;

  const exec = parseExecForm(command);
  if (exec) return exec;

  const argv = tokenize(command);
  if (!argv) return ['/bin/sh', '-c', command];
  if (argv.length === 0) return null;
  if (isExplicitShell(argv)) return argv;
  if (SHELL_OPERATORS.test(command)) return ['/bin/sh', '-c', command];
  return argv;
}

/**
 * Whether a deployment's `startCommand` is a runtime override at all.
 *
 * Railpack folds it into the image at build time instead (see
 * docker.service.loadBuildEnv), so applying it to the pod as well would run it
 * twice over. Every other build type — Dockerfile builds and image-source
 * deployments, which never run a builder — has nowhere else to put it.
 */
export function usesRuntimeStartCommand(buildType: string | null | undefined): boolean {
  return buildType !== 'railpack';
}

export function startArgsFor(deployment: {
  buildType?: string | null;
  startCommand?: string | null;
}): string[] | null {
  if (!usesRuntimeStartCommand(deployment.buildType)) return null;
  return resolveStartArgs(deployment.startCommand);
}
