import { AsyncLocalStorage } from 'async_hooks';

export interface RequestAuthContext {
  apiTokenId?: string;
  tokenScopes?: string[];
  // Empty/undefined = no project restriction. Non-empty = the token holder can
  // only touch projects whose ID is in this list, regardless of their user role.
  tokenProjectIds?: string[];
}

export const requestAuthStorage = new AsyncLocalStorage<RequestAuthContext>();
