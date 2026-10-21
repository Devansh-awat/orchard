import type { DockerfileHealthCheck } from '../github/dockerfile-healthcheck';

/**
 * Which health check a deployment actually runs with.
 *
 * A repo that declares `HEALTHCHECK` in its Dockerfile has already answered
 * the question, and that answer travels with the code — so it wins over
 * Orchard's own defaults without anyone opening the settings tab. The stored
 * configuration is still kept, untouched, behind `healthCheckOverride`: that
 * flag is the user saying "I know what the image says, do this instead".
 */
export interface StoredHealthCheck {
  healthCheckEnabled: boolean;
  healthCheckType: string;
  healthCheckPath?: string | null;
  healthCheckPort?: number | null;
  healthCheckCommand?: string | null;
  livenessEnabled: boolean;
  readinessEnabled: boolean;
  startupEnabled: boolean;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  healthCheckRetries: number;
  startupFailureThreshold: number;
  healthCheckOverride: boolean;
  dockerfileHealthCheck?: unknown;
}

export interface ResolvedHealthCheck {
  enabled: boolean;
  source: 'dockerfile' | 'manual';
  type: string;
  path?: string | null;
  port?: number | null;
  command?: string | null;
  execCommand?: string[] | null;
  livenessEnabled: boolean;
  readinessEnabled: boolean;
  startupEnabled: boolean;
  interval: number;
  timeout: number;
  retries: number;
  startupFailureThreshold: number;
}

const DOCKER_DEFAULT_INTERVAL = 30;
const DOCKER_DEFAULT_TIMEOUT = 30;
const DOCKER_DEFAULT_RETRIES = 3;

export function coerceDockerfileHealthCheck(value: unknown): DockerfileHealthCheck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const command = record.command;
  if (!Array.isArray(command) || command.length === 0) return null;
  if (command.some((arg) => typeof arg !== 'string')) return null;

  const positive = (input: unknown) =>
    typeof input === 'number' && Number.isFinite(input) && input > 0
      ? Math.round(input)
      : undefined;

  return {
    command: command as string[],
    interval: positive(record.interval),
    timeout: positive(record.timeout),
    retries: positive(record.retries),
    startPeriod: positive(record.startPeriod)
  };
}

const LOOPBACK = '(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])';
const URL_LITERAL = new RegExp('http://' + LOOPBACK + '(?::(\\d+))?(/[^\\s\'"\\u0060)|;&\\\\]*)?');
const ENV_PORT_CONCAT = new RegExp(
  '([\'"\\u0060])http://' +
    LOOPBACK +
    ':\\1\\s*\\+\\s*\\(?\\s*process\\.env\\.PORT\\b[^+]*\\+\\s*([\'"\\u0060])(/[^\'"\\u0060]*)\\2'
);
const ENV_PORT_TEMPLATE = new RegExp(
  '\\u0060http://' + LOOPBACK + ':\\$\\{[^}]*\\}(/[^\\u0060]*)\\u0060'
);
const CURL_FAIL = /(?:^|\s)(?:-[a-zA-Z]*f[a-zA-Z]*|--fail(?:-with-body)?)(?=\s|$)/;

export function loopbackHttpProbe(
  command: string[],
  appPort?: number | null
): { path: string; port: number } | null {
  const script = command.join(' ');
  const tool = /\bcurl\b/.test(script)
    ? 'curl'
    : /\bwget\b/.test(script)
      ? 'wget'
      : /\bfetch\s*\(/.test(script)
        ? 'fetch'
        : null;
  if (!tool) return null;
  if (tool !== 'fetch' && /&&|;/.test(script)) return null;
  if (tool === 'curl' && !CURL_FAIL.test(script)) return null;
  if (tool === 'fetch' && !/\.ok\b|\.status\b/.test(script)) return null;
  const fromEnv = ENV_PORT_CONCAT.exec(script) ?? ENV_PORT_TEMPLATE.exec(script);
  if (fromEnv) {
    const path = fromEnv[3] ?? fromEnv[1];
    return appPort ? { path: path || '/', port: appPort } : null;
  }
  const literal = URL_LITERAL.exec(script);
  if (!literal) return null;
  return { path: literal[2] || '/', port: literal[1] ? Number(literal[1]) : 80 };
}

export function resolveHealthCheck(
  stored: StoredHealthCheck,
  appPort?: number | null
): ResolvedHealthCheck {
  const detected = stored.healthCheckOverride
    ? null
    : coerceDockerfileHealthCheck(stored.dockerfileHealthCheck);

  if (detected) {
    const interval = detected.interval ?? DOCKER_DEFAULT_INTERVAL;
    const retries = detected.retries ?? DOCKER_DEFAULT_RETRIES;
    // Docker lets a check take as long as the interval between checks; the
    // kubelet would queue the overlap, so a timeout longer than the period is
    // cut back to it rather than left to pile up.
    const timeout = Math.min(detected.timeout ?? DOCKER_DEFAULT_TIMEOUT, interval);
    // `--start-period` is grace, not health: failures inside it are not
    // counted. A startup probe is the same bargain — liveness and readiness
    // stay quiet until it passes.
    const startPeriod = detected.startPeriod ?? 0;
    const http = loopbackHttpProbe(detected.command, appPort);

    return {
      enabled: true,
      source: 'dockerfile',
      type: http ? 'http' : 'exec',
      path: http?.path ?? null,
      port: http?.port ?? null,
      command: http ? null : detected.command.join(' '),
      execCommand: http ? null : detected.command,
      livenessEnabled: true,
      readinessEnabled: true,
      startupEnabled: startPeriod > 0,
      interval,
      timeout,
      retries,
      startupFailureThreshold: Math.max(1, Math.ceil(startPeriod / interval) + retries)
    };
  }

  return {
    enabled: stored.healthCheckEnabled,
    source: 'manual',
    type: stored.healthCheckType,
    path: stored.healthCheckPath ?? null,
    port: stored.healthCheckPort ?? null,
    command: stored.healthCheckCommand ?? null,
    execCommand: null,
    livenessEnabled: stored.livenessEnabled,
    readinessEnabled: stored.readinessEnabled,
    startupEnabled: stored.startupEnabled,
    interval: stored.healthCheckInterval,
    timeout: stored.healthCheckTimeout,
    retries: stored.healthCheckRetries,
    startupFailureThreshold: stored.startupFailureThreshold
  };
}
