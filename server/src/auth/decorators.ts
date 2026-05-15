import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const REQUIRES_AUTH_KEY = 'requiresAuth';
export const Auth = () => SetMetadata(REQUIRES_AUTH_KEY, true);

export const REQUIRES_SUPERADMIN_KEY = 'requires_superadmin';
export const SuperAdmin = () => SetMetadata(REQUIRES_SUPERADMIN_KEY, true);

// API tokens carry a `scopes` array (e.g. ["read", "deploy", "exec"]). When
// a route is hit via an API token, ScopeGuard enforces the route's required
// scope against the token's granted scopes. Session-authenticated requests
// are unaffected — scopes only apply to programmatic token auth.
export type ApiTokenScopeName = 'read' | 'deploy' | 'exec';
export const REQUIRED_SCOPE_KEY = 'required_scope';
export const RequireScope = (scope: ApiTokenScopeName) =>
  SetMetadata(REQUIRED_SCOPE_KEY, scope);
