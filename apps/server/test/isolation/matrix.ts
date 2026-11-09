import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MATRIX_PATH,
  type InventoryRoute,
  type IsolationClass,
  ISOLATION_CLASSES
} from './inventory';
import { FIELD_KIND, isSeededKind, isTenantKind } from './kinds';

export type MatrixEntry = {
  class: IsolationClass;
  auth: 'public' | 'authenticated' | 'superadmin';
  handler: string;
  params: string[];
  queryIds: string[];
  bodyIds: string[];
  unseeded: string[];
  reason?: string;
};

export type Matrix = Record<string, MatrixEntry>;

export const GRAFT_REASON =
  'Graft route. Grafts are trusted first-party code loaded only with the graft runtime, and their authority is not an isolation finding (DEVELOPERS.md); graft sandboxes are covered in docs/ai-sandbox.md.';

const ID_QUERY = /(Id|Ids)$|^namespace$|^orgId$/;

export function structuralEntry(route: InventoryRoute): Omit<MatrixEntry, 'class' | 'reason'> {
  const tenantKinds = route.pathParams.map((param) => param.kind).filter(isTenantKind);
  return {
    auth: route.auth,
    handler: route.handler,
    params: route.pathParams.map((param) => `${param.name}:${param.kind}`),
    queryIds: route.queryParams.filter((name) => ID_QUERY.test(name)).sort(),
    bodyIds: route.bodyIds,
    unseeded: [...new Set(tenantKinds.filter((kind) => !isSeededKind(kind)))].sort()
  };
}

export function proposeClass(route: InventoryRoute): IsolationClass {
  if (route.graft) return 'exempt';
  if (route.auth === 'public') return 'public';
  if (route.auth === 'superadmin') return 'superadmin';
  const scoped = route.pathParams.some((param) => isTenantKind(param.kind));
  const refs = [...route.queryParams, ...route.bodyIds].some(
    (name) => ID_QUERY.test(name) && name in FIELD_KIND
  );
  return scoped || refs ? 'resource-scoped' : 'own-scope-only';
}

export function proposeReason(route: InventoryRoute): string | undefined {
  return route.graft ? GRAFT_REASON : undefined;
}

export function readMatrix(): Matrix {
  if (!existsSync(MATRIX_PATH)) return {};
  return JSON.parse(readFileSync(MATRIX_PATH, 'utf8')) as Matrix;
}

export function writeMatrix(matrix: Matrix): void {
  const sorted = Object.fromEntries(Object.entries(matrix).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MATRIX_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

export function mergeMatrix(
  routes: InventoryRoute[],
  previous: Matrix,
  acceptProposed: boolean
): Matrix {
  const next: Matrix = {};
  for (const route of routes) {
    const structure = structuralEntry(route);
    const existing = previous[route.key];
    const cls = existing?.class ?? (acceptProposed ? proposeClass(route) : 'unclassified');
    const reason = existing?.reason ?? (acceptProposed ? proposeReason(route) : undefined);
    next[route.key] = { class: cls, ...structure, ...(reason ? { reason } : {}) };
  }
  return next;
}

export function validateMatrix(routes: InventoryRoute[], matrix: Matrix): string[] {
  const problems: string[] = [];
  const keys = new Set(routes.map((route) => route.key));
  for (const route of routes) {
    const entry = matrix[route.key];
    if (!entry) {
      problems.push(`NEW ROUTE not in isolation-matrix.json: ${route.key} (${route.handler})`);
      continue;
    }
    if (!ISOLATION_CLASSES.includes(entry.class)) {
      problems.push(`${route.key}: unknown class "${entry.class}"`);
      continue;
    }
    if (entry.class === 'unclassified') {
      problems.push(
        `${route.key}: unclassified. Choose public, own-scope-only, resource-scoped, superadmin or exempt (with a reason).`
      );
      continue;
    }
    const structure = structuralEntry(route);
    for (const field of ['auth', 'params', 'queryIds', 'bodyIds', 'unseeded'] as const) {
      if (JSON.stringify(entry[field]) !== JSON.stringify(structure[field])) {
        problems.push(
          `${route.key}: ${field} changed (matrix ${JSON.stringify(entry[field])}, code ${JSON.stringify(structure[field])}). Re-review the isolation decision and regenerate.`
        );
      }
    }
    if (entry.class === 'exempt') {
      if (!entry.reason || entry.reason.trim().length < 20) {
        problems.push(`${route.key}: exempt routes need a written reason (20+ characters).`);
      }
      continue;
    }
    if (route.auth === 'public' && entry.class !== 'public') {
      problems.push(`${route.key}: auth is public but class is ${entry.class}`);
    }
    if (route.auth === 'superadmin' && entry.class !== 'superadmin') {
      problems.push(`${route.key}: auth is superadmin but class is ${entry.class}`);
    }
    if (
      route.auth === 'authenticated' &&
      (entry.class === 'public' || entry.class === 'superadmin')
    ) {
      problems.push(`${route.key}: auth is authenticated but class is ${entry.class}`);
    }
    if (route.auth === 'authenticated') {
      const unknown = route.pathParams.filter((param) => param.kind === 'unknown');
      for (const param of unknown) {
        problems.push(
          `${route.key}: path param :${param.name} has no resource kind (inventory.ts)`
        );
      }
      const scoped = route.pathParams.some((param) => isTenantKind(param.kind));
      if (entry.class === 'own-scope-only' && scoped) {
        problems.push(
          `${route.key}: takes a resource id in the path, so it cannot be own-scope-only`
        );
      }
      if (
        entry.class === 'resource-scoped' &&
        !scoped &&
        entry.queryIds.length + entry.bodyIds.length === 0
      ) {
        problems.push(`${route.key}: resource-scoped but carries no resource id`);
      }
    }
  }
  for (const key of Object.keys(matrix)) {
    if (!keys.has(key)) problems.push(`REMOVED ROUTE still in isolation-matrix.json: ${key}`);
  }
  return problems;
}

export function routeFromMatrix(key: string, entry: MatrixEntry): InventoryRoute {
  const space = key.indexOf(' ');
  return {
    key,
    method: key.slice(0, space),
    path: key.slice(space + 1),
    controller: entry.handler.split('.')[0],
    handler: entry.handler,
    graft: null,
    auth: entry.auth,
    pathParams: entry.params.map((param) => {
      const [name, kind] = param.split(':');
      return { name, kind };
    }),
    queryParams: entry.queryIds,
    hasBody: true,
    bodyIds: entry.bodyIds,
    file: ''
  };
}

export function summarize(matrix: Matrix) {
  const counts: Record<string, number> = {};
  for (const entry of Object.values(matrix)) counts[entry.class] = (counts[entry.class] ?? 0) + 1;
  return counts;
}
