import type * as k8s from '@kubernetes/client-node';
import { canonicalIp } from './public-ip-policy';

export type PublicEndpointState = 'ready' | 'pending' | 'failed' | 'unknown';

export interface PublicEndpointStatus {
  state: PublicEndpointState;
  addresses: string[];
  reason: string | null;
}

export interface PublicEndpointFacts {
  service: k8s.V1Service | null;
  events: k8s.CoreV1Event[];
  balancerPods: k8s.V1Pod[];
  now: number;
}

export const SERVICELB_NAME_LABEL = 'svccontroller.k3s.cattle.io/svcname';
export const SERVICELB_NAMESPACE_LABEL = 'svccontroller.k3s.cattle.io/svcnamespace';
export const NO_BALANCER_AFTER_MS = 5 * 60 * 1000;
const REASON_MAX = 220;

export const UNKNOWN_PUBLIC_ENDPOINT: PublicEndpointStatus = {
  state: 'unknown',
  addresses: [],
  reason: null
};

function timeOf(value: Date | string | undefined | null): number {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function eventTime(event: k8s.CoreV1Event): number {
  return Math.max(
    timeOf(event.series?.lastObservedTime as any),
    timeOf(event.lastTimestamp as any),
    timeOf(event.eventTime as any),
    timeOf(event.firstTimestamp as any),
    timeOf(event.metadata?.creationTimestamp as any)
  );
}

export function cleanBalancerMessage(raw: string | null | undefined): string {
  let text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const prefixes = [
    /^error syncing load balancer:\s*/i,
    /^failed to ensure load balancer:\s*/i,
    /^failed to allocate ip for "[^"]*":\s*/i,
    /^failed to allocate ip for [^:]*:\s*/i
  ];
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of prefixes) {
      if (prefix.test(text)) {
        text = text.replace(prefix, '');
        stripped = true;
      }
    }
  }
  text = text.replace(/\s*preemption:.*$/i, '').trim();
  if (!text) return '';
  if (text.length > REASON_MAX) text = `${text.slice(0, REASON_MAX - 1).trimEnd()}…`;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.…!?]$/.test(text) ? text : `${text}.`;
}

function withDetail(lead: string, raw: string | null | undefined): string {
  const detail = cleanBalancerMessage(raw);
  if (!detail) return `${lead}.`;
  const first = detail.match(/^[A-Za-z]+/)?.[0] ?? '';
  const plainWord = /^[A-Z][a-z]*$/.test(first) && !/^[A-Za-z]+[:(]/.test(detail);
  return `${lead}: ${plainWord ? detail.charAt(0).toLowerCase() + detail.slice(1) : detail}`;
}

function assignedAddresses(service: k8s.V1Service): string[] {
  const out: string[] = [];
  for (const ingress of service.status?.loadBalancer?.ingress ?? []) {
    const value = canonicalIp(ingress.ip) ?? (ingress.hostname || '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function failedCondition(service: k8s.V1Service): string | null {
  const conditions = (service.status?.conditions ?? []) as k8s.V1Condition[];
  const failed = conditions.find((c) => c.status === 'False');
  if (!failed) return null;
  return withDetail('No address could be assigned', failed.message || failed.reason);
}

function unschedulableBalancer(service: k8s.V1Service, pods: k8s.V1Pod[]): string | null {
  for (const pod of pods) {
    const scheduled = pod.status?.conditions?.find((c) => c.type === 'PodScheduled');
    if (scheduled?.status !== 'False' || scheduled.reason !== 'Unschedulable') continue;
    const message = scheduled.message ?? '';
    if (/free ports|port.*(in use|conflict)/i.test(message)) {
      const port = service.spec?.ports?.[0]?.port;
      return port
        ? `Port ${port} is already in use on the server, so the load balancer cannot listen on it.`
        : 'The port is already in use on the server, so the load balancer cannot listen on it.';
    }
    return withDetail('The load balancer cannot start', message);
  }
  return null;
}

function warningReason(event: k8s.CoreV1Event): string {
  switch (event.reason) {
    case 'AllocationFailed':
      return withDetail('No address could be allocated', event.message);
    case 'SyncLoadBalancerFailed':
    case 'LoadBalancerFailed':
      return withDetail('The load balancer could not be created', event.message);
    case 'UnAvailableLoadBalancer':
      return 'No server is ready to carry this port.';
    default:
      return withDetail('The load balancer reported an error', event.message || event.reason);
  }
}

export function publicEndpointStatus(facts: PublicEndpointFacts): PublicEndpointStatus {
  const { service } = facts;
  if (!service) {
    return {
      state: 'failed',
      addresses: [],
      reason: 'The load balancer for this port is missing. Turn public access off and on again.'
    };
  }

  const uid = service.metadata?.uid;
  const events = facts.events.filter(
    (e) =>
      e.involvedObject?.kind === 'Service' &&
      (uid ? e.involvedObject?.uid === uid : e.involvedObject?.name === service.metadata?.name)
  );
  const addresses = assignedAddresses(service);
  const requested = canonicalIp(service.spec?.loadBalancerIP);

  if (addresses.length > 0) {
    if (!requested || addresses.includes(requested) || facts.balancerPods.length > 0) {
      return { state: 'ready', addresses, reason: null };
    }
    return {
      state: 'failed',
      addresses,
      reason: `The load balancer assigned ${addresses.join(', ')} instead of ${requested}.`
    };
  }

  const condition = failedCondition(service);
  if (condition) return { state: 'failed', addresses, reason: condition };

  const unschedulable = unschedulableBalancer(service, facts.balancerPods);
  if (unschedulable) return { state: 'failed', addresses, reason: unschedulable };

  const warning = events
    .filter((e) => e.type === 'Warning')
    .sort((a, b) => eventTime(b) - eventTime(a))[0];
  if (warning) return { state: 'failed', addresses, reason: warningReason(warning) };

  const created = timeOf(service.metadata?.creationTimestamp as any);
  const untouched = events.length === 0 && facts.balancerPods.length === 0;
  if (untouched && created > 0 && facts.now - created >= NO_BALANCER_AFTER_MS) {
    return {
      state: 'failed',
      addresses,
      reason: 'No load balancer assigned an address after 5 minutes.'
    };
  }

  return { state: 'pending', addresses, reason: null };
}
