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
}

export const requestAuthStorage = new AsyncLocalStorage<RequestAuthContext>();
