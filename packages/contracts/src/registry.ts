import { routes } from './routes.generated';
import { attachments } from './schemas';
import type { GeneratedRoute, Route, Scope } from './types';

export type { Auth, GeneratedRoute, Method, Route, RouteAttachment, Scope } from './types';

export function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

export function requiredScopeOf(route: Pick<GeneratedRoute, 'method' | 'requiredScope'>): Scope {
  if (route.requiredScope) return route.requiredScope;
  return route.method === 'GET' ? 'read' : 'deploy';
}

export const registry: Route[] = routes.map((route) => ({
  ...route,
  ...attachments[routeKey(route)]
}));
