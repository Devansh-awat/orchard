import { AsyncLocalStorage } from 'async_hooks';

export interface RequestAuthContext {
  apiTokenId?: string;
  tokenScopes?: string[];
  // Empty/undefined = no project restriction. Non-empty = the token holder can
  // only touch projects whose ID is in this list, regardless of their user role.
  tokenProjectIds?: string[];
  // Set when the session was minted by an organization's own identity provider.
  // That org vouched for the identity, so the session is confined to it: an
  // org's IdP (or whoever compromises it) must not become a way to reach the
  // other tenants its users happen to belong to.
  sessionOrgId?: string;
  sessionId?: string;
  browserSession?: boolean;
  mcpGateway?: boolean;
  orgSsoRefused?: boolean;
}

export const requestAuthStorage = new AsyncLocalStorage<RequestAuthContext>();

export const PERSONAL_CREDENTIAL_REFUSED =
  "This credential can't use a personal GitHub link or personal git connection. Connect an organization-level credential (a GitHub App installation or git connection owned by the organization) or deploy a public repository.";

export function personalCredentialsRefused(): boolean {
  return Boolean(requestAuthStorage.getStore()?.sessionOrgId);
}

export function personalSourceSelectionRefused(): boolean {
  const ctx = requestAuthStorage.getStore();
  return Boolean(ctx?.sessionOrgId || ctx?.tokenProjectIds?.length);
}
