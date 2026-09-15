import { routes } from './routes.generated';
import { attachments } from './schemas';
import type { Route } from './types';

export type { Auth, GeneratedRoute, Method, Route, RouteAttachment, Scope } from './types';

export function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

export const registry: Route[] = routes.map((route) => ({
  ...route,
  ...attachments[routeKey(route)]
}));
