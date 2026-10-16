import type { GraftManifest } from './manifest';

export type ClaimKind =
  | 'apiAliases'
  | 'uiAliases'
  | 'wsAliases'
  | 'hostRouting'
  | 'notificationEvents'
  | 'notificationCategories'
  | 'configSections'
  | 'settingKeys'
  | 'rateLimitBuckets'
  | 'mcpTools'
  | 'sseEvents'
  | 'auditActions'
  | 'applyOps'
  | 'deviceNames'
  | 'engineShards';

export const CLAIM_KINDS: ClaimKind[] = [
  'apiAliases',
  'uiAliases',
  'wsAliases',
  'hostRouting',
  'notificationEvents',
  'notificationCategories',
  'configSections',
  'settingKeys',
  'rateLimitBuckets',
  'mcpTools',
  'sseEvents',
  'auditActions',
  'applyOps',
  'deviceNames',
  'engineShards'
];

const PATH_KINDS: ClaimKind[] = ['apiAliases', 'uiAliases', 'wsAliases'];

export type ClaimState = 'own' | 'alias' | 'shadowed';

export type ResolvedClaim = {
  kind: ClaimKind;
  value: string;
  state: ClaimState;
  shadowedBy?: string;
};

export function ownsName(graftId: string, value: string): boolean {
  return (
    value === graftId ||
    value.startsWith(`${graftId}.`) ||
    value.startsWith(`${graftId}-`) ||
    value.startsWith(`${graftId}/`) ||
    value.startsWith(`${graftId}:`) ||
    value.startsWith(`${graftId.replace(/-/g, '_')}_`)
  );
}

function firstSegment(value: string): string {
  return value.split('/')[0];
}

function overlaps(kind: ClaimKind, a: string, b: string): boolean {
  const sep = PATH_KINDS.includes(kind) ? '/' : '.';
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

export function resolveClaims(
  grafts: Pick<GraftManifest, 'id' | 'claims'>[],
  coreTaken: Partial<Record<ClaimKind, (value: string) => boolean>> = {}
): Map<string, ResolvedClaim[]> {
  const taken = new Map<ClaimKind, { value: string; owner: string }[]>();
  const result = new Map<string, ResolvedClaim[]>();
  const ids = new Set(grafts.map((g) => g.id));

  for (const graft of grafts) {
    const resolved: ResolvedClaim[] = [];
    for (const kind of CLAIM_KINDS) {
      for (const value of graft.claims[kind] ?? []) {
        const own = ownsName(graft.id, kind.endsWith('Aliases') ? firstSegment(value) : value);
        const list = taken.get(kind) ?? [];
        const prior = list.find((t) => overlaps(kind, t.value, value));
        const foreignOwner = [...ids].find(
          (other) =>
            other !== graft.id &&
            ownsName(other, kind.endsWith('Aliases') ? firstSegment(value) : value)
        );
        let claim: ResolvedClaim;
        if (coreTaken[kind]?.(value)) {
          claim = { kind, value, state: 'shadowed', shadowedBy: 'core' };
        } else if (foreignOwner) {
          claim = { kind, value, state: 'shadowed', shadowedBy: foreignOwner };
        } else if (prior) {
          claim = { kind, value, state: 'shadowed', shadowedBy: prior.owner };
        } else {
          claim = { kind, value, state: own ? 'own' : 'alias' };
          list.push({ value, owner: graft.id });
          taken.set(kind, list);
        }
        resolved.push(claim);
      }
    }
    result.set(graft.id, resolved);
  }
  return result;
}

export function activeClaims(resolved: ResolvedClaim[] | undefined, kind: ClaimKind): string[] {
  return (resolved ?? [])
    .filter((c) => c.kind === kind && c.state !== 'shadowed')
    .map((c) => c.value);
}

export function canUseName(
  graftId: string,
  resolved: ResolvedClaim[] | undefined,
  kind: ClaimKind,
  name: string
): boolean {
  if (ownsName(graftId, name)) return true;
  const sep = PATH_KINDS.includes(kind) ? '/' : '.';
  return activeClaims(resolved, kind).some(
    (claim) => name === claim || name.startsWith(`${claim}${sep}`)
  );
}
