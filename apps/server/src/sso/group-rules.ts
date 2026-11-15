export const MAX_GROUPS = 500;
export const MAX_GROUP_LENGTH = 256;
export const MAX_CLAIM_BYTES = 16 * 1024;
export const MAX_RULES_PER_ORG = 1000;
export const MAX_CLAIM_NAME_LENGTH = 256;
const MAX_CLAIM_PATH_DEPTH = 4;
const ENTRA_SAML_GROUPS_LINK = 'http://schemas.microsoft.com/claims/groups.link';

export const MAPPABLE_ROLES = ['admin', 'member', 'guest'] as const;
export type MappableRole = (typeof MAPPABLE_ROLES)[number];

const RANK: Record<MappableRole, number> = { guest: 0, member: 1, admin: 2 };

export interface GroupRule {
  id: string;
  organizationId: string;
  value: string;
  role: string;
}

export type GroupsResult =
  | { kind: 'groups'; groups: Set<string> }
  | { kind: 'unknown'; reason: 'overage' | 'too_many' | 'too_large' | 'malformed' | 'unsupported' };

export interface OrgDecision {
  role: MappableRole;
  ruleIds: string[];
}

export function isMappableRole(role: unknown): role is MappableRole {
  return typeof role === 'string' && (MAPPABLE_ROLES as readonly string[]).includes(role);
}

export function outranks(a: MappableRole, b: MappableRole): boolean {
  return RANK[a] > RANK[b];
}

const FORBIDDEN = /[\p{C}\p{Zl}\p{Zp}]/u;
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

export function normalizeGroup(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const group = value.normalize('NFC').trim();
  if (!group || group.length > MAX_GROUP_LENGTH || FORBIDDEN.test(group)) return null;
  return group;
}

export class RuleValueError extends Error {}

export function ruleValue(value: unknown): string {
  const group = normalizeGroup(value);
  if (!group) {
    throw new RuleValueError(
      `Group names must be 1-${MAX_GROUP_LENGTH} characters with no control or invisible characters`
    );
  }
  const used = SCRIPTS.filter((re) => [...group].some((ch) => re.test(ch)));
  if (used.length > 1) {
    throw new RuleValueError(
      `Group name "${group}" mixes Latin, Cyrillic or Greek letters; use one script so lookalike names cannot be confused`
    );
  }
  return group;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function validClaimName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_CLAIM_NAME_LENGTH &&
    trimmed === name &&
    !FORBIDDEN.test(name) &&
    !name.split('.').some((part) => UNSAFE_KEYS.has(part))
  );
}

function lookup(claims: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(claims, name)) return claims[name];
  if (!name.includes('.')) return undefined;
  const parts = name.split('.');
  if (parts.length > MAX_CLAIM_PATH_DEPTH) return undefined;
  let current: unknown = claims;
  for (const part of parts) {
    if (
      UNSAFE_KEYS.has(part) ||
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, part)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function hasOverageMarker(claims: Record<string, unknown>, name: string): boolean {
  if (claims.hasgroups === true || Object.hasOwn(claims, ENTRA_SAML_GROUPS_LINK)) return true;
  const names = claims._claim_names;
  return (
    typeof names === 'object' &&
    names !== null &&
    !Array.isArray(names) &&
    Object.hasOwn(names, name.split('.')[0])
  );
}

export function extractGroups(claims: Record<string, unknown>, claimName: string): GroupsResult {
  if (!validClaimName(claimName)) return { kind: 'unknown', reason: 'malformed' };
  const raw = lookup(claims, claimName);
  if (raw === undefined || raw === null) {
    return hasOverageMarker(claims, claimName)
      ? { kind: 'unknown', reason: 'overage' }
      : { kind: 'groups', groups: new Set() };
  }
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length > MAX_GROUPS) return { kind: 'unknown', reason: 'too_many' };
  let bytes = 0;
  const groups = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    bytes += value.length;
    if (bytes > MAX_CLAIM_BYTES) return { kind: 'unknown', reason: 'too_large' };
    const group = normalizeGroup(value);
    if (group) groups.add(group);
  }
  return { kind: 'groups', groups };
}

export function resolveRoles(
  rules: readonly GroupRule[],
  groups: ReadonlySet<string>
): Map<string, OrgDecision> {
  const decisions = new Map<string, OrgDecision>();
  for (const rule of rules) {
    if (!groups.has(rule.value) || !isMappableRole(rule.role)) continue;
    const current = decisions.get(rule.organizationId);
    if (!current) {
      decisions.set(rule.organizationId, { role: rule.role, ruleIds: [rule.id] });
    } else if (outranks(rule.role, current.role)) {
      decisions.set(rule.organizationId, { role: rule.role, ruleIds: [rule.id] });
    } else if (rule.role === current.role) {
      current.ruleIds.push(rule.id);
    }
  }
  return decisions;
}
