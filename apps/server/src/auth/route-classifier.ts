import 'reflect-metadata';

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const IS_PUBLIC_KEY = 'isPublic';
const REQUIRES_AUTH_KEY = 'requiresAuth';
const REQUIRES_SUPERADMIN_KEY = 'requires_superadmin';

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'ALL',
  'OPTIONS',
  'HEAD',
  'SEARCH'
] as const;

export type RouteClassification = 'public' | 'authenticated' | 'superadmin';

type AuthMeta = { isPublic?: boolean; requiresAuth?: boolean; requiresSuperadmin?: boolean };

export type ClassifiedRoute = {
  key: string;
  method: string;
  path: string;
  classification: RouteClassification;
  handler: string;
};

export function classifyRoute(handlerMeta: AuthMeta, classMeta: AuthMeta): RouteClassification {
  if (handlerMeta.requiresSuperadmin || classMeta.requiresSuperadmin) return 'superadmin';
  if (handlerMeta.isPublic) return 'public';
  if (handlerMeta.requiresAuth || classMeta.requiresAuth) return 'authenticated';
  if (classMeta.isPublic) return 'public';
  return 'superadmin';
}

function authMeta(target: object): AuthMeta {
  return {
    isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, target) as boolean | undefined,
    requiresAuth: Reflect.getMetadata(REQUIRES_AUTH_KEY, target) as boolean | undefined,
    requiresSuperadmin: Reflect.getMetadata(REQUIRES_SUPERADMIN_KEY, target) as boolean | undefined
  };
}

export function isController(cls: unknown): cls is new (...args: unknown[]) => unknown {
  return typeof cls === 'function' && Reflect.getMetadata(PATH_METADATA, cls) !== undefined;
}

export function joinRoutePath(...parts: string[]): string {
  return `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function classifyController(
  cls: new (...args: unknown[]) => unknown,
  prefix = '',
  conflicts: string[] = []
): ClassifiedRoute[] {
  const controllerPaths = Reflect.getMetadata(PATH_METADATA, cls) as string | string[];
  const classMeta = authMeta(cls);
  const routes: ClassifiedRoute[] = [];
  const proto = cls.prototype as Record<string, unknown>;
  for (const methodName of Object.getOwnPropertyNames(proto)) {
    if (methodName === 'constructor') continue;
    const handler = proto[methodName];
    if (typeof handler !== 'function') continue;
    const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    if (httpMethod === undefined) continue;
    const handlerMeta = authMeta(handler);
    if (handlerMeta.isPublic && handlerMeta.requiresAuth) {
      conflicts.push(`${cls.name}.${methodName} has BOTH @Auth() and @Public()`);
    }
    const classification = classifyRoute(handlerMeta, classMeta);
    const method = HTTP_METHODS[httpMethod] ?? `UNKNOWN(${httpMethod})`;
    const subPaths =
      (Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined) ?? '';
    for (const base of Array.isArray(controllerPaths) ? controllerPaths : [controllerPaths]) {
      for (const sub of Array.isArray(subPaths) ? subPaths : [subPaths]) {
        const path = joinRoutePath(prefix, base, sub);
        routes.push({
          key: `${method} ${path}`,
          method,
          path,
          classification,
          handler: `${cls.name}.${methodName}`
        });
      }
    }
  }
  return routes;
}

export function routeTable(
  routes: ClassifiedRoute[],
  conflicts: string[] = []
): Record<string, RouteClassification> {
  const table: Record<string, RouteClassification> = {};
  for (const route of routes) {
    if (route.key in table && table[route.key] !== route.classification) {
      conflicts.push(
        `${route.key} declared with conflicting classifications (${table[route.key]} vs ${route.classification})`
      );
    }
    table[route.key] = route.classification;
  }
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
}
