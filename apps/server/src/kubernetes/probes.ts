import type * as k8s from '@kubernetes/client-node';

export const FAST_PROBE_PERIOD_SECONDS = 5;

export interface ProbeSpec {
  type: string;
  path?: string | null;
  port?: number | null;
  command?: string | null;
  execCommand?: string[] | null;
  interval: number;
  timeout: number;
  retries: number;
  startupFailureThreshold: number;
}

export interface ProbeToggles {
  enabled: boolean;
  livenessEnabled: boolean;
  readinessEnabled: boolean;
  startupEnabled: boolean;
}

export interface ProbeSet {
  liveness: k8s.V1Probe | null;
  readiness: k8s.V1Probe | null;
  startup: k8s.V1Probe | null;
}

export function probeExecCommand(command?: string | null, execCommand?: string[] | null): string[] {
  if (execCommand && execCommand.length > 0) return execCommand;
  if (command) return command.split(' ');
  return ['/bin/sh', '-c', 'exit 0'];
}

function handler(spec: ProbeSpec): Pick<k8s.V1Probe, 'httpGet' | 'tcpSocket' | 'exec'> {
  if (spec.type === 'http') return { httpGet: { path: spec.path || '/', port: spec.port || 80 } };
  if (spec.type === 'tcp') return { tcpSocket: { port: spec.port || 80 } };
  if (spec.type === 'exec')
    return { exec: { command: probeExecCommand(spec.command, spec.execCommand) } };
  return {};
}

function fastPeriod(interval: number): number {
  return Math.max(1, Math.min(interval, FAST_PROBE_PERIOD_SECONDS));
}

function scaledThreshold(count: number, interval: number, period: number): number {
  return Math.max(1, Math.ceil((count * interval) / period));
}

export function livenessProbe(spec: ProbeSpec): k8s.V1Probe {
  return {
    periodSeconds: spec.interval,
    timeoutSeconds: spec.timeout,
    failureThreshold: spec.retries,
    ...handler(spec)
  };
}

export function readinessProbe(spec: ProbeSpec): k8s.V1Probe {
  const period = fastPeriod(spec.interval);
  return {
    periodSeconds: period,
    timeoutSeconds: spec.timeout,
    failureThreshold: scaledThreshold(spec.retries, spec.interval, period),
    ...handler(spec)
  };
}

export function startupProbe(spec: ProbeSpec): k8s.V1Probe {
  const period = fastPeriod(spec.interval);
  return {
    periodSeconds: period,
    timeoutSeconds: spec.timeout,
    failureThreshold: scaledThreshold(spec.startupFailureThreshold, spec.interval, period),
    ...handler(spec)
  };
}

export function probesFor(spec: ProbeSpec & ProbeToggles): ProbeSet {
  const on = spec.enabled;
  return {
    liveness: on && spec.livenessEnabled ? livenessProbe(spec) : null,
    readiness: on && spec.readinessEnabled ? readinessProbe(spec) : null,
    startup: on && spec.startupEnabled ? startupProbe(spec) : null
  };
}
