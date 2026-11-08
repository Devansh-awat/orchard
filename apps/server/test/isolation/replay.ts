import { randomBytes, randomUUID } from 'node:crypto';
import { EXCEPTION_HEADER } from './recording-filter';
import type { InventoryRoute } from './inventory';
import { FIELD_KIND, isTenantKind, kindLevel } from './kinds';
import type { Principal } from './principals';
import { forbiddenMarkers } from './principals';
import { diffSnapshots, diffTouchesMarkers, type RowSnapshot, type Snapshotter } from './snapshot';
import type { OrgCtx, ProjectCtx, UserCtx, World } from './world';

export type Outcome = {
  status: number;
  text: string;
  contentType: string;
  exception: string | null;
  timedOut: boolean;
  ms: number;
};

export type Bucket = 'denied' | 'rejected' | 'allowed' | 'error' | 'timeout';

export type FindingKind = 'allowed' | 'error-reached' | 'timeout' | 'leak' | 'mutated' | 'oracle';

export interface Finding {
  id: string;
  kind: FindingKind;
  route: string;
  principal: string;
  variant: Variant;
  status: number;
  detail: string;
  request: string;
}

export type Variant = 'foreign' | 'mixed' | 'missing';

export interface Probe {
  principal: string;
  variant: Variant;
  request: string;
  status: number;
  bucket: Bucket;
  expectedDeny: boolean;
  exception: string | null;
}

const DEFAULT_SPRAY = [
  'organizationId',
  'orgId',
  'projectId',
  'deploymentId',
  'databaseId',
  'environmentId',
  'namespace'
];

const SELF_DESTRUCTIVE: Record<string, string[]> = {
  'POST /organizations/:id/leave': ['cross-project', 'lower-role']
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface Scope {
  org: OrgCtx | null;
  project: ProjectCtx | null;
  user: UserCtx | null;
}

export function victimScope(world: World, principal: Principal): Scope {
  const org = world.orgs[principal.victim.orgKey];
  const project = world.projects[principal.victim.projectKey];
  const user = world.users[principal.victim.orgKey === 'o1' ? 'o1Owner' : 'o2Owner'];
  return { org, project, user };
}

export function ownScope(world: World, principal: Principal): Scope {
  return {
    org: principal.home.orgKey ? world.orgs[principal.home.orgKey] : null,
    project: principal.home.projectKey ? world.projects[principal.home.projectKey] : null,
    user: principal.userKey ? world.users[principal.userKey] : null
  };
}

export function idFor(
  kind: string,
  scope: Scope,
  world: World,
  routePath: string
): string | undefined {
  const level = kindLevel(kind);
  if (kind === 'template') return world.templateId;
  if (kind === 'slug') {
    if (routePath.startsWith('/status/')) return scope.org?.ids.statusSlug;
    return scope.org?.slug;
  }
  if (kind === 'subdomain') return scope.org?.slug;
  if (level === 'project') return scope.project?.ids[kind];
  if (level === 'org') return scope.org?.ids[kind];
  if (level === 'user') return scope.user?.ids[kind] ?? scope.org?.ids[kind];
  if (kind === 'githubOwner') return 'octocat';
  if (kind === 'githubRepo') return 'hello-world';
  if (kind === 'provider') return 'github';
  if (kind === 'scopeType') return 'org';
  if (kind === 'stepOrder') return '1';
  if (kind === 'name') return 'probe';
  return `probe-${randomBytes(4).toString('hex')}`;
}

function fresh(value: string): string {
  return UUID.test(value) ? randomUUID() : `nx-${randomBytes(6).toString('hex')}`;
}

export function sprayNames(route: InventoryRoute): string[] {
  const extra = [...route.queryParams, ...route.bodyIds].filter((name) => name in FIELD_KIND);
  return [...new Set([...DEFAULT_SPRAY, ...extra])];
}

export function buildSpray(
  route: InventoryRoute,
  scope: Scope,
  world: World
): Record<string, string | string[]> {
  const spray: Record<string, string | string[]> = {};
  for (const name of sprayNames(route)) {
    const kind = FIELD_KIND[name];
    if (!kind) continue;
    const value = idFor(kind, scope, world, route.path);
    if (!value) continue;
    spray[name] = name.endsWith('Ids') ? [value] : value;
  }
  return spray;
}

export interface BuiltRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  echo: string[];
  label: string;
}

export function buildRequest(
  route: InventoryRoute,
  variant: Variant,
  victim: Scope,
  own: Scope | null,
  world: World,
  keepOrgLevel = false
): BuiltRequest | null {
  const tenantParams = route.pathParams.filter((param) => isTenantKind(param.kind));
  const pathValues: Record<string, string> = {};
  if (variant === 'mixed') {
    const declaredRefs = [...route.queryParams, ...route.bodyIds].some(
      (name) => name in FIELD_KIND
    );
    if (!own || !tenantParams.length) return null;
    if (tenantParams.length < 2 && !declaredRefs) return null;
    if (kindLevel(tenantParams[0].kind) === 'user') return null;
    if (!idFor(tenantParams[0].kind, own, world, route.path)) return null;
  }
  route.pathParams.forEach((param) => {
    const scope = variant === 'mixed' && own && param === tenantParams[0] ? own : victim;
    const value = idFor(param.kind, scope, world, route.path);
    pathValues[param.name] = value ?? `probe-${randomBytes(4).toString('hex')}`;
  });
  const spray = buildSpray(route, victim, world);
  let sprayOut: Record<string, string | string[]> = spray;
  if (variant === 'missing') {
    // A same-org principal already knows its own org exists, so the "unknown id"
    // twin keeps the org-level ids and only invents the project-level ones.
    // Otherwise "you are a non-admin of this org" (403) would be compared with
    // "no such org" (404) and flagged although it reveals nothing about the project.
    const keep = (kind: string | undefined) =>
      keepOrgLevel && kind !== undefined && kindLevel(kind) === 'org';
    for (const key of Object.keys(pathValues)) {
      const kind = route.pathParams.find((p) => p.name === key)!.kind;
      if (isTenantKind(kind) && !keep(kind)) {
        pathValues[key] = fresh(pathValues[key]);
      }
    }
    sprayOut = {};
    for (const [key, value] of Object.entries(spray)) {
      if (keep(FIELD_KIND[key])) {
        sprayOut[key] = value;
        continue;
      }
      sprayOut[key] = Array.isArray(value) ? value.map(fresh) : fresh(value);
    }
  }
  let pathText = route.path;
  for (const [name, value] of Object.entries(pathValues)) {
    pathText = pathText.replace(`:${name}`, encodeURIComponent(value));
  }
  const isRead = route.method === 'GET' || route.method === 'HEAD';
  const query: Record<string, string> = {};
  if (isRead) {
    for (const [key, value] of Object.entries(sprayOut)) {
      query[key] = Array.isArray(value) ? value.join(',') : value;
    }
  }
  const body = isRead ? null : { ...sprayOut, name: 'isolation-probe' };
  const queryText = Object.entries(query)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const declared = new Set([...route.queryParams, ...route.bodyIds]);
  const echo = [
    ...Object.values(pathValues),
    ...Object.entries(sprayOut)
      .filter(([name]) => declared.has(name))
      .flatMap(([, value]) => value),
    'isolation-probe'
  ].filter((value) => value.length >= 4);
  return {
    method: route.method,
    path: pathText,
    query,
    body,
    echo,
    label: `${route.method} ${pathText}${queryText ? `?${queryText}` : ''}${body ? ` ${JSON.stringify(body)}` : ''}`
  };
}

export async function send(
  baseUrl: string,
  request: BuiltRequest,
  headers: Record<string, string>,
  timeoutMs = 5000
): Promise<Outcome> {
  const url = new URL(baseUrl + request.path);
  for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method: request.method,
      headers: {
        ...headers,
        ...(request.body ? { 'content-type': 'application/json' } : {})
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
      redirect: 'manual'
    };
    const response = await fetch(url, init);
    const contentType = response.headers.get('content-type') ?? '';
    const exceptionHeader = response.headers.get(EXCEPTION_HEADER);
    let text = '';
    if (contentType.includes('text/event-stream')) {
      const reader = response.body?.getReader();
      if (reader) {
        const first = await Promise.race([
          reader
            .read()
            .then((chunk) =>
              chunk.done ? 'event: error\n(stream closed)' : new TextDecoder().decode(chunk.value)
            ),
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 3000))
        ]).catch(() => 'event: error\n(stream failed)');
        text = first.slice(0, 2000);
        await reader.cancel().catch(() => undefined);
      }
    } else {
      text = (await response.text()).slice(0, 200_000);
    }
    return {
      status: response.status,
      text,
      contentType,
      exception: exceptionHeader ? decodeURIComponent(exceptionHeader) : null,
      timedOut: false,
      ms: Date.now() - started
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      status: aborted ? 0 : -1,
      text: aborted ? '' : String((error as Error)?.message ?? error),
      contentType: '',
      exception: null,
      timedOut: aborted,
      ms: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

export function bucketOf(outcome: Outcome): Bucket {
  if (outcome.timedOut) return 'timeout';
  const s = outcome.status;
  if (s === 401 || s === 403 || s === 404) return 'denied';
  if (s >= 200 && s < 400) return 'allowed';
  if (s >= 500 || s < 0) return 'error';
  return 'rejected';
}

export function expectDenied(route: InventoryRoute, principal: Principal): boolean {
  if (principal.relation === 'owner') return false;
  if (route.method === 'GET' && principal.writesOnly) return false;
  if (principal.relation === 'anon' || principal.relation === 'cross-org') return true;
  const kinds = route.pathParams.map((param) => param.kind).filter((kind) => kind !== 'scopeId');
  const refKinds = [...route.queryParams, ...route.bodyIds]
    .map((name) => FIELD_KIND[name])
    .filter(Boolean);
  const levels = [...kinds, ...refKinds].map((kind) => kindLevel(kind));
  const isWrite = route.method !== 'GET' && route.method !== 'HEAD';
  if (principal.relation === 'lower-role') return isWrite;
  if (levels.includes('user') || levels.includes('project')) {
    return kinds.some((kind) => kindLevel(kind) === 'project' || kindLevel(kind) === 'user');
  }
  return isWrite;
}

export function messageOf(outcome: Outcome): string {
  try {
    const parsed = JSON.parse(outcome.text);
    const message = parsed?.message ?? parsed?.error ?? '';
    return Array.isArray(message) ? message.join('; ') : String(message);
  } catch {
    return outcome.text.slice(0, 120);
  }
}

export function normalizeBody(text: string, markers: readonly string[]): string {
  let out = text.replace(UUID_G, '<id>');
  for (const marker of markers) if (marker.length >= 4) out = out.split(marker).join('<m>');
  return out.replace(/nx-[0-9a-f]{12}/g, '<id>').replace(/probe-[0-9a-f]{8}/g, '<id>');
}

export function findMarkers(text: string, forbidden: readonly string[]): string[] {
  const hits: string[] = [];
  for (const marker of forbidden) {
    if (text.includes(marker)) {
      hits.push(marker);
      if (hits.length >= 3) break;
    }
  }
  return hits;
}

export interface RouteRunContext {
  baseUrl: string;
  world: World;
  principals: Principal[];
  snapshotter: Snapshotter;
  state: { snapshot: RowSnapshot };
  forbidden: Map<string, string[]>;
  allMarkers: string[];
  resourceMarkers: string[];
}

export interface RouteResult {
  findings: Finding[];
  probes: Probe[];
}

export async function runRoute(
  route: InventoryRoute,
  cls: 'resource-scoped' | 'own-scope-only',
  ctx: RouteRunContext
): Promise<RouteResult> {
  const findings: Finding[] = [];
  const probes: Probe[] = [];
  const isWrite = route.method !== 'GET' && route.method !== 'HEAD';
  const hasPathScope = route.pathParams.some((param) => isTenantKind(param.kind));

  const note = (finding: Omit<Finding, 'id' | 'route'>, principal: string) => {
    findings.push({
      ...finding,
      id: `${finding.kind} | ${route.key} | ${principal}`,
      route: route.key
    });
  };

  const trackSideEffects = async (
    principal: Principal,
    label: string,
    status: number,
    variant: Variant
  ) => {
    if (status >= 400 && status < 500) return;
    const after = await ctx.snapshotter.take();
    const hits = diffTouchesMarkers(
      diffSnapshots(ctx.state.snapshot, after),
      ctx.forbidden.get(principal.key) ?? []
    );
    ctx.state.snapshot = after;
    if (hits.length) {
      note(
        {
          kind: 'mutated',
          principal: principal.key,
          variant,
          status,
          detail: `rows touching other tenants changed: ${hits.slice(0, 4).join(', ')}`,
          request: label
        },
        principal.key
      );
    }
  };

  for (const principal of ctx.principals) {
    if (principal.writesOnly && !isWrite) continue;
    if (cls === 'resource-scoped' && principal.relation === 'owner') continue;
    if (SELF_DESTRUCTIVE[route.key]?.includes(principal.relation)) continue;
    if (cls === 'own-scope-only' && principal.relation === 'lower-role') continue;
    const victim = victimScope(ctx.world, principal);
    const own =
      principal.home.orgKey || principal.home.projectKey ? ownScope(ctx.world, principal) : null;
    const variants: Variant[] =
      cls === 'resource-scoped' && hasPathScope ? ['foreign', 'mixed', 'missing'] : ['foreign'];
    const results: Partial<Record<Variant, { outcome: Outcome; label: string }>> = {};
    for (const variant of variants) {
      if (
        variant === 'missing' &&
        (principal.relation === 'owner' || principal.relation === 'lower-role')
      )
        continue;
      if (variant === 'mixed' && principal.relation === 'anon') continue;
      const built = buildRequest(
        route,
        variant,
        victim,
        own,
        ctx.world,
        variant === 'missing' && principal.relation === 'cross-project'
      );
      if (!built) continue;
      const outcome = await send(ctx.baseUrl, built, principal.headers);
      const bucket = bucketOf(outcome);
      const deny =
        cls === 'resource-scoped' &&
        hasPathScope &&
        variant === 'foreign' &&
        expectDenied(route, principal);
      probes.push({
        principal: principal.key,
        variant,
        request: built.label,
        status: outcome.status,
        bucket,
        expectedDeny: deny,
        exception: outcome.exception
      });
      results[variant] = { outcome, label: built.label };

      let unechoed = outcome.text;
      for (const value of built.echo) unechoed = unechoed.split(value).join('');
      const leak = findMarkers(unechoed, ctx.forbidden.get(principal.key) ?? []);
      if (leak.length) {
        note(
          {
            kind: 'leak',
            principal: principal.key,
            variant,
            status: outcome.status,
            detail: `response contains other tenants' data: ${leak.join(', ')}`,
            request: built.label
          },
          principal.key
        );
      }
      if (deny) {
        if (bucket === 'allowed') {
          note(
            {
              kind: 'allowed',
              principal: principal.key,
              variant,
              status: outcome.status,
              detail: `expected 401/403/404, got ${outcome.status}: ${outcome.text.slice(0, 160)}`,
              request: built.label
            },
            principal.key
          );
        } else if (bucket === 'error') {
          note(
            {
              kind: 'error-reached',
              principal: principal.key,
              variant,
              status: outcome.status,
              detail: `expected 401/403/404, got ${outcome.status} ${outcome.exception ?? outcome.text.slice(0, 160)}`,
              request: built.label
            },
            principal.key
          );
        } else if (bucket === 'timeout') {
          note(
            {
              kind: 'timeout',
              principal: principal.key,
              variant,
              status: 0,
              detail: 'no response within the timeout (handler reached?)',
              request: built.label
            },
            principal.key
          );
        }
      }
      await trackSideEffects(principal, built.label, outcome.status, variant);
    }

    const foreign = results.foreign;
    const missing = results.missing;
    const hiddenFromPrincipal =
      principal.relation === 'cross-org' ||
      (principal.relation === 'cross-project' &&
        route.pathParams.some(
          (p) => kindLevel(p.kind) === 'project' || kindLevel(p.kind) === 'user'
        ));
    if (cls === 'resource-scoped' && foreign && missing && hiddenFromPrincipal) {
      const f = foreign.outcome;
      const m = missing.outcome;
      const markers = ctx.allMarkers;
      const sameStatus = f.status === m.status;
      const sameBody =
        normalizeBody(f.text, markers) === normalizeBody(m.text, markers) ||
        (f.status >= 400 && messageOf(f) === messageOf(m));
      if (!sameStatus || (f.status >= 400 && !sameBody)) {
        note(
          {
            kind: 'oracle',
            principal: principal.key,
            variant: 'foreign',
            status: f.status,
            detail: `existing foreign id -> ${f.status} "${messageOf(f).slice(0, 80)}" but unknown id -> ${m.status} "${messageOf(m).slice(0, 80)}"`,
            request: foreign.label
          },
          principal.key
        );
      }
    }
  }

  const after = await ctx.snapshotter.take();
  const hits = diffTouchesMarkers(diffSnapshots(ctx.state.snapshot, after), ctx.resourceMarkers);
  ctx.state.snapshot = after;
  if (hits.length) {
    note(
      {
        kind: 'mutated',
        principal: '(a 4xx request)',
        variant: 'foreign',
        status: 0,
        detail: `rows changed despite 4xx responses: ${hits.slice(0, 4).join(', ')}`,
        request: route.key
      },
      '(a 4xx request)'
    );
  }
  return { findings, probes };
}

export function buildForbidden(world: World, principals: Principal[]): Map<string, string[]> {
  return new Map(
    principals.map((principal) => [principal.key, forbiddenMarkers(world, principal)])
  );
}
