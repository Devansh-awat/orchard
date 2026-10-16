import type * as k8s from '@kubernetes/client-node';
import { Prisma } from '@prisma/client';
import { ALLOWED_INGRESS_ANNOTATION_KEYS } from '../../kubernetes/kubernetes.service';

export const PROTECTION_PROXY_SERVICE = 'orchard-protection-proxy';

const ISSUER_ANNOTATION = 'cert-manager.io/cluster-issuer';

const BASIC_AUTH_MARKER = 'orchard.my/basic-auth';

const MAX_COLUMN_LENGTH = 255;

export const ADOPTED_ANNOTATION_KEYS = [...ALLOWED_INGRESS_ANNOTATION_KEYS].filter(
  (key) => key !== BASIC_AUTH_MARKER
);

export interface AdoptableIngressRow {
  id: string;
  projectId: string;
  deploymentId: string | null;
  serviceId: string | null;
  environmentId: string | null;
  namespace: string;
  name: string;
  host: string;
  path: string;
  pathType: string;
  tlsSecretName: string | null;
  tlsHosts: string[];
  ingressClass: string | null;
  entrypoints: string[];
  clusterIssuer: string | null;
  annotations: unknown;
  statusAddress: string | null;
  protectionMode: string;
  redirectTarget: string | null;
  servicePort: number | null;
}

export interface KnownService {
  id: string;
  name: string;
  deploymentId: string;
  ports: number[];
}

export interface ObservedPath {
  path: string;
  pathType: string;
  serviceName: string | null;
  servicePort: number | null;
}

export interface IngressRowUpdate {
  row: AdoptableIngressRow;
  data: Record<string, unknown>;
}

export interface IngressRowCreate {
  path: ObservedPath;
  service: KnownService;
  data: Record<string, unknown>;
}

export interface IngressAdoptionPlan {
  updates: IngressRowUpdate[];
  removals: AdoptableIngressRow[];
  creations: IngressRowCreate[];
  skipped: string[];
}

interface ObservedTls {
  secretName: string | null;
  hosts: string[];
}

interface Routing {
  host: string;
  paths: ObservedPath[];
}

function observedRouting(ingress: k8s.V1Ingress): Routing | null {
  const rules = ingress.spec?.rules ?? [];
  if (rules.length !== 1) return null;
  const host = rules[0].host?.trim().toLowerCase();
  if (!host || host.length > MAX_COLUMN_LENGTH) return null;
  const raw = rules[0].http?.paths ?? [];
  if (raw.length === 0) return null;
  const paths: ObservedPath[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    const path = p.path || '/';
    if (path.length > MAX_COLUMN_LENGTH) return null;
    if (seen.has(path)) continue;
    seen.add(path);
    const port = p.backend?.service?.port?.number;
    paths.push({
      path,
      pathType: p.pathType || 'Prefix',
      serviceName: p.backend?.service?.name ?? null,
      servicePort: typeof port === 'number' ? port : null
    });
  }
  return { host, paths };
}

export function observedIngressHost(ingress: k8s.V1Ingress): string | null {
  return observedRouting(ingress)?.host ?? null;
}

function observedTls(ingress: k8s.V1Ingress): ObservedTls | null {
  const entries = ingress.spec?.tls ?? [];
  if (entries.length === 0) return { secretName: null, hosts: [] };
  if (entries.length > 1) return null;
  const secretName = entries[0].secretName?.trim();
  if (!secretName || secretName.length > MAX_COLUMN_LENGTH) return null;
  return { secretName, hosts: entries[0].hosts ?? [] };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function storedAnnotations(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, string>) };
}

function mergedAnnotations(
  row: AdoptableIngressRow,
  live: Record<string, string>
): Record<string, string> | null {
  const next = storedAnnotations(row.annotations);
  let changed = false;
  for (const key of ADOPTED_ANNOTATION_KEYS) {
    const value = live[key];
    if (value === undefined) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    } else if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? next : null;
}

export function backendService(path: ObservedPath, services: KnownService[]): KnownService | null {
  if (!path.serviceName || path.servicePort === null) return null;
  if (path.serviceName === PROTECTION_PROXY_SERVICE) return null;
  const service = services.find((s) => s.name === path.serviceName);
  if (!service || !service.ports.includes(path.servicePort)) return null;
  return service;
}

function backendChanges(
  row: AdoptableIngressRow,
  path: ObservedPath,
  services: KnownService[]
): Record<string, unknown> {
  const service = backendService(path, services);
  if (!service) return {};
  const data: Record<string, unknown> = {};
  if (row.serviceId !== service.id) data.serviceId = service.id;
  if (row.servicePort !== path.servicePort) data.servicePort = path.servicePort;
  if (row.deploymentId !== service.deploymentId) data.deploymentId = service.deploymentId;
  return data;
}

function objectChanges(
  row: AdoptableIngressRow,
  ingress: k8s.V1Ingress,
  routing: Routing | null,
  tls: ObservedTls | null,
  hostAvailable: boolean
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (routing && hostAvailable && routing.host !== row.host) data.host = routing.host;

  if (tls) {
    if (tls.secretName !== row.tlsSecretName) data.tlsSecretName = tls.secretName;
    if (!sameList(tls.hosts, row.tlsHosts ?? [])) data.tlsHosts = tls.hosts;
    if (Boolean(tls.secretName) !== Boolean(row.tlsSecretName)) {
      const entrypoints = tls.secretName ? ['websecure'] : ['web'];
      if (!sameList(entrypoints, row.entrypoints ?? [])) data.entrypoints = entrypoints;
    }
  }

  const ingressClass = ingress.spec?.ingressClassName ?? null;
  if ((ingressClass === null || ingressClass.length <= 100) && ingressClass !== row.ingressClass) {
    data.ingressClass = ingressClass;
  }

  const live = ingress.metadata?.annotations ?? {};
  const annotations = mergedAnnotations(row, live);
  if (annotations) {
    data.annotations = Object.keys(annotations).length > 0 ? annotations : Prisma.DbNull;
  }
  const issuer = live[ISSUER_ANNOTATION] ?? null;
  if ((issuer === null || issuer.length <= MAX_COLUMN_LENGTH) && issuer !== row.clusterIssuer) {
    data.clusterIssuer = issuer;
  }
  return data;
}

export function planIngressAdoption(
  ingress: k8s.V1Ingress,
  rows: AdoptableIngressRow[],
  services: KnownService[],
  hostAvailable: boolean
): IngressAdoptionPlan {
  const plan: IngressAdoptionPlan = {
    updates: [],
    removals: [],
    creations: [],
    skipped: []
  };
  if (rows.length === 0) return plan;

  const routing = observedRouting(ingress);
  const tls = observedTls(ingress);
  if (!routing) plan.skipped.push('rules are not one host with paths; routing left alone');
  if (!tls) plan.skipped.push('tls is not a single secret; tls left alone');
  if (routing && !hostAvailable && routing.host !== rows[0].host) {
    plan.skipped.push(`host ${routing.host} belongs to another project; host left alone`);
  }

  const proxied = rows.some((row) => row.protectionMode !== 'none' || row.redirectTarget !== null);
  const byPath = new Map(routing?.paths.map((p) => [p.path, p] as const) ?? []);
  const unmatched = routing ? rows.filter((row) => !byPath.has(row.path)) : [];
  const claimed = new Set(rows.map((row) => row.path));
  const unclaimed = routing ? routing.paths.filter((p) => !claimed.has(p.path)) : [];
  const renamed = unmatched.length === 1 && unclaimed.length === 1 ? unclaimed[0] : null;

  for (const row of rows) {
    const data = objectChanges(row, ingress, routing, tls, hostAvailable);
    const path = byPath.get(row.path) ?? (renamed && unmatched[0] === row ? renamed : null);
    if (path) {
      if (path.path !== row.path) data.path = path.path;
      if (path.pathType !== row.pathType) data.pathType = path.pathType;
      if (!proxied) Object.assign(data, backendChanges(row, path, services));
    }
    if (Object.keys(data).length > 0) plan.updates.push({ row, data });
  }

  if (!routing || renamed) return plan;

  if (unmatched.length > 0 && unclaimed.length === 0) {
    plan.removals = unmatched;
    return plan;
  }
  if (unmatched.length > 0) {
    plan.skipped.push(
      `paths ${unmatched.map((r) => r.path).join(',')} gone and ${unclaimed.map((p) => p.path).join(',')} new; cannot tell which became which`
    );
    return plan;
  }
  if (unclaimed.length === 0) return plan;

  if (rows.length < 2) {
    plan.skipped.push(
      `paths ${unclaimed.map((p) => p.path).join(',')} have no row; a single-row ingress keeps extra paths in the cluster only`
    );
    return plan;
  }
  if (proxied) {
    plan.skipped.push(
      `paths ${unclaimed.map((p) => p.path).join(',')} have no row; backends behind the protection proxy cannot be read`
    );
    return plan;
  }

  const template = rows[0];
  const merged = { ...template, ...plan.updates.find((u) => u.row === template)?.data };
  for (const path of unclaimed) {
    const service = backendService(path, services);
    if (!service) {
      plan.skipped.push(
        `path ${path.path} routes to ${path.serviceName ?? 'nothing'}:${path.servicePort ?? '?'}, which is not a known service port`
      );
      continue;
    }
    plan.creations.push({
      path,
      service,
      data: {
        projectId: template.projectId,
        deploymentId: service.deploymentId,
        serviceId: service.id,
        environmentId: template.environmentId,
        name: template.name,
        namespace: template.namespace,
        host: merged.host,
        path: path.path,
        pathType: path.pathType,
        tlsSecretName: merged.tlsSecretName,
        tlsHosts: merged.tlsHosts,
        ingressClass: merged.ingressClass,
        entrypoints: merged.entrypoints,
        clusterIssuer: merged.clusterIssuer,
        annotations: merged.annotations ?? Prisma.DbNull,
        statusAddress: template.statusAddress,
        servicePort: path.servicePort
      }
    });
  }
  return plan;
}
