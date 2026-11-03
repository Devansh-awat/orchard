// Server-side resolution of ${{shared.KEY}} references in environment variable
// values. Shared values may reference other shared values; deployment values
// reference the (already resolved) shared set. Resolution happens at inject
// time (pod spec + build args) so shared-var edits propagate without rewriting
// stored rows, and the literal ${{...}} never reaches the container.

export const SHARED_REF_RE = /\$\{\{\s*shared\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// ${{resource.<binding>.<field>}} reads a live value off a resource bound to
// the deployment (a managed database today). It is resolved at inject time
// like a shared ref, so a rotated password or a restored cluster reaches
// every bound app without anyone re-saving env. Unlike a shared ref it never
// degrades to an empty string: an app started against a dangling reference
// would fail somewhere far less legible than here.
export const RESOURCE_REF_RE =
  /\$\{\{\s*resource\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface ResourceValues {
  [binding: string]: { fields: Record<string, string>; secretFields?: readonly string[] };
}

export class UnresolvedResourceRefError extends Error {
  constructor(
    readonly key: string,
    readonly ref: string,
    reason: 'unbound' | 'missing-field' = 'unbound'
  ) {
    const [, binding, field] = ref.split('.');
    super(
      reason === 'unbound'
        ? `${key} references ${ref}, which is not connected to this app`
        : `${key} references ${ref}, but ${binding} has no ${field} yet`
    );
    this.name = 'UnresolvedResourceRefError';
  }
}

export interface EnvVar {
  key: string;
  value: string;
  secret?: boolean;
}

export interface ResolveError {
  key: string;
  missingRef: string;
}

/**
 * Fully resolve a shared-var set among itself. Handles transitive references
 * and cycles (a cycle expands to empty + records an error, never loops).
 * Returns a value map plus which keys carry a secret (transitively).
 */
export function resolveSharedValues(shared: EnvVar[]): {
  values: Map<string, string>;
  secretKeys: Set<string>;
  errors: ResolveError[];
} {
  const raw = new Map<string, string>();
  const secretFlag = new Map<string, boolean>();
  for (const v of shared) {
    raw.set(v.key, v.value);
    secretFlag.set(v.key, Boolean(v.secret));
  }
  const resolved = new Map<string, string>();
  const secretKeys = new Set<string>();
  const errors: ResolveError[] = [];

  const resolveKey = (key: string, stack: Set<string>): string => {
    if (resolved.has(key)) return resolved.get(key)!;
    if (!raw.has(key)) return '';
    if (stack.has(key)) {
      // cycle: break it
      errors.push({ key, missingRef: `<cycle:${key}>` });
      return '';
    }
    stack.add(key);
    if (secretFlag.get(key)) secretKeys.add(key);
    const out = raw.get(key)!.replace(SHARED_REF_RE, (_m, ref: string) => {
      if (!raw.has(ref)) {
        errors.push({ key, missingRef: ref });
        return '';
      }
      if (secretFlag.get(ref)) secretKeys.add(key);
      return resolveKey(ref, stack);
    });
    stack.delete(key);
    resolved.set(key, out);
    return out;
  };

  for (const v of shared) resolveKey(v.key, new Set());
  return { values: resolved, secretKeys, errors };
}

/**
 * Expand ${{shared.KEY}} references in a deployment's env values using a fully
 * resolved shared set. A deployment var that references a secret shared var is
 * itself marked secret so it routes through the k8s Secret channel.
 */
export function resolveEnvVars(
  rawVars: EnvVar[],
  shared: EnvVar[],
  resources: ResourceValues = {}
): { resolved: EnvVar[]; errors: ResolveError[] } {
  const { values, secretKeys, errors: sharedErrors } = resolveSharedValues(shared);
  const errors: ResolveError[] = [...sharedErrors];
  const resolved = rawVars.map((v) => {
    let inheritedSecret = false;
    const value = v.value
      .replace(SHARED_REF_RE, (_m, ref: string) => {
        if (!values.has(ref)) {
          errors.push({ key: v.key, missingRef: ref });
          return '';
        }
        if (secretKeys.has(ref)) inheritedSecret = true;
        return values.get(ref)!;
      })
      .replace(RESOURCE_REF_RE, (_m, binding: string, field: string) => {
        const bound = resources[binding];
        if (!bound) throw new UnresolvedResourceRefError(v.key, `resource.${binding}.${field}`);
        if (!Object.hasOwn(bound.fields, field)) {
          throw new UnresolvedResourceRefError(
            v.key,
            `resource.${binding}.${field}`,
            'missing-field'
          );
        }
        const found = bound.fields[field];
        if (bound.secretFields?.includes(field)) inheritedSecret = true;
        return found;
      });
    return { key: v.key, value, secret: Boolean(v.secret) || inheritedSecret };
  });
  return { resolved, errors };
}

/** Every resource.<binding>.<field> pair referenced by a set of values. */
export function referencedResourceRefs(
  vars: EnvVar[]
): { key: string; binding: string; field: string }[] {
  const out: { key: string; binding: string; field: string }[] = [];
  for (const v of vars) {
    for (const m of v.value.matchAll(RESOURCE_REF_RE)) {
      out.push({ key: v.key, binding: m[1], field: m[2] });
    }
  }
  return out;
}

/** Collect the shared keys referenced by a set of values (for save-time validation). */
export function referencedSharedKeys(vars: EnvVar[]): Set<string> {
  const keys = new Set<string>();
  for (const v of vars) {
    for (const m of v.value.matchAll(SHARED_REF_RE)) keys.add(m[1]);
  }
  return keys;
}
