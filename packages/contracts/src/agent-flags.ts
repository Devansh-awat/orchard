export const SENSITIVE_OPERATIONS = new Set<string>([
  'GET /databases/:id/connection',
  'POST /databases/:id/rotate-password',
  'GET /projects/:id/ingresses/:ingressId/protection',
  'GET /users/me/git-connections/:connectionId/webhook-secret',
  'POST /deployments/:id/webhook-tokens',
  'POST /organizations/:id/notification-channels',
  'POST /auth/tokens',
  'POST /organizations/:id/scim/tokens',
  'POST /pods/:podName/exec'
]);

export const REQUIRED_SCOPES = new Map<string, 'read' | 'deploy' | 'exec'>([
  ['GET /databases/:id/connection', 'deploy'],
  ['GET /projects/:id/ingresses/:ingressId/protection', 'deploy'],
  ['GET /users/me/git-connections/:connectionId/webhook-secret', 'deploy'],
  ['POST /pods/:podName/exec', 'exec']
]);

export const DESTRUCTIVE_OPERATIONS = new Set<string>([
  'PUT /deployments/:id/env',
  'PUT /environments/:id/shared-vars',
  'PUT /deployments/:id/volumes',
  'PUT /deployments/:deploymentId/services/:serviceId',
  'PATCH /databases/:id/settings',
  'PUT /jobs/:id/steps',
  'POST /deployments/:id/stop',
  'POST /databases/:id/stop',
  'POST /databases/:id/restore',
  'POST /databases/:id/rotate-password',
  'POST /projects/:id/transfer-org',
  'POST /deployments/:id/cancel'
]);

export const AGENT_HIDDEN_PREFIXES = [
  '/admin',
  '/setup',
  '/scim',
  '/sso',
  '/.well-known',
  '/authorize',
  '/register',
  '/token',
  '/auth/passkey',
  '/auth/password',
  '/auth/mcp-token',
  '/auth/login',
  '/auth/callback',
  '/auth/logout'
];

export function isSensitiveOperation(method: string, path: string): boolean {
  return SENSITIVE_OPERATIONS.has(`${method.toUpperCase()} ${path}`);
}

export function isDestructiveOperation(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'DELETE' || DESTRUCTIVE_OPERATIONS.has(`${upper} ${path}`);
}

export function isAgentVisible(route: { method: string; path: string; auth: string }): boolean {
  if (route.auth !== 'authenticated') return false;
  if (route.method.toUpperCase() === 'ALL') return false;
  return !AGENT_HIDDEN_PREFIXES.some(
    (prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)
  );
}
