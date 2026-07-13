import type { ZodTypeAny } from 'zod';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Auth = 'public' | 'authenticated' | 'superadmin';

export type Scope = 'read' | 'deploy' | 'exec';

export interface GeneratedRoute {
  method: Method;
  path: string;
  auth: Auth;
}

export interface RouteAttachment {
  request?: ZodTypeAny;
  response?: ZodTypeAny;
  summary?: string;
  scope?: Scope;
}

export interface Route extends GeneratedRoute, RouteAttachment {}
