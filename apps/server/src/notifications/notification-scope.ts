import { RuleScopeType } from './notification-events';

export interface ScopeRef {
  scopeType: string;
  scopeId: string | null;
}

export interface ResolvedScope extends ScopeRef {
  scopeType: RuleScopeType;
  projectId: string | null;
  label: string;
}

// Everything a scope inherits from, broadest first: the org, the owning
// project, then the resource itself. Rules add up along this chain and
// destinations are offerable along it, so both read it from here rather than
// rebuilding the same three lines with a different bug in each.
export function scopeChain(scope: ResolvedScope): ScopeRef[] {
  const chain: ScopeRef[] = [{ scopeType: 'org', scopeId: null }];
  if (scope.projectId) chain.push({ scopeType: 'project', scopeId: scope.projectId });
  if (scope.scopeType !== 'org' && scope.scopeType !== 'project') {
    chain.push({ scopeType: scope.scopeType, scopeId: scope.scopeId });
  }
  return chain;
}

export function isSameScope(a: ScopeRef, b: ScopeRef): boolean {
  return a.scopeType === b.scopeType && (a.scopeId ?? null) === (b.scopeId ?? null);
}

// Owned by the scope you are looking at, rather than inherited from above. An
// owned destination is the only one a scope admin may rename or delete: the
// org's shared webhook stays the org's.
export function ownsChannel(scope: ResolvedScope, channel: ScopeRef): boolean {
  return isSameScope(scope, channel);
}

export function isChannelVisibleAt(scope: ResolvedScope, channel: ScopeRef): boolean {
  return scopeChain(scope).some((link) => isSameScope(link, channel));
}
