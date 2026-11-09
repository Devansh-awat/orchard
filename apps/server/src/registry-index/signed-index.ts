import { OFFICIAL_GRAFT_KEYS, signedWith } from '../grafts/integrity';

export type RegistrySignaturePolicy = 'auto' | 'required';

export type RegistryIndexState = { sequence: number; signed: boolean; revoked?: string[] };

export interface RegistryIndexStateStore {
  load(name: string): Promise<RegistryIndexState | null>;
  save(name: string, state: RegistryIndexState): Promise<void>;
}

export type VerifiedRegistryIndex = {
  signed: boolean;
  sequence: number | null;
  body: unknown;
  warnings: string[];
};

export const REGISTRY_SIGNATURE_ENV = 'ORCHARD_REGISTRY_SIGNATURE';

export class MissingRegistryObject extends Error {}

export function registrySignaturePolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RegistrySignaturePolicy {
  const value = (env[REGISTRY_SIGNATURE_ENV] || 'required').trim().toLowerCase();
  if (value === 'auto' || value === 'required') return value;
  throw new Error(`${REGISTRY_SIGNATURE_ENV} must be auto or required (got "${value}")`);
}

export function registryStateKey(name: string): string {
  return `registry_index_state:${name}`;
}

export function parseRegistryState(raw: string | null | undefined): RegistryIndexState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RegistryIndexState>;
    if (typeof parsed.sequence !== 'number' || !Number.isSafeInteger(parsed.sequence)) return null;
    return {
      sequence: parsed.sequence,
      signed: parsed.signed === true,
      ...(Array.isArray(parsed.revoked) && parsed.revoked.every((d) => typeof d === 'string')
        ? { revoked: parsed.revoked as string[] }
        : {})
    };
  } catch {
    return null;
  }
}

export function verifyRegistryIndex(input: {
  name: string;
  raw: Buffer;
  signature: string | null;
  state: RegistryIndexState | null;
  policy: RegistrySignaturePolicy;
  now?: Date;
  keys?: string[];
}): VerifiedRegistryIndex {
  const { name, raw, signature, state, policy } = input;
  const now = input.now ?? new Date();
  if (signature === null) {
    if (policy === 'required') {
      throw new Error(
        `${name} is unsigned. To use a registry you run yourself, set ${REGISTRY_SIGNATURE_ENV}=auto`
      );
    }
    if (state?.signed) {
      throw new Error(
        `${name} is unsigned but an earlier copy was signed; refusing the downgrade (possible tampering)`
      );
    }
    return {
      signed: false,
      sequence: null,
      body: JSON.parse(raw.toString('utf8')),
      warnings: [
        `${name} is NOT signed. Trusting it anyway because the registry has not published a signature yet; set ${REGISTRY_SIGNATURE_ENV}=required once it does`
      ]
    };
  }
  if (!signedWith(raw, signature, input.keys ?? OFFICIAL_GRAFT_KEYS)) {
    throw new Error(`${name} signature does not verify against an Orchard key`);
  }
  const body = JSON.parse(raw.toString('utf8')) as { sequence?: unknown; expiresAt?: unknown };
  if (typeof body.sequence !== 'number' || !Number.isSafeInteger(body.sequence)) {
    throw new Error(`${name} is signed but has no sequence number`);
  }
  const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
  if (Number.isNaN(expiresAt)) throw new Error(`${name} is signed but has no valid expiresAt`);
  if (expiresAt <= now.getTime()) throw new Error(`${name} expired at ${body.expiresAt}`);
  if (state && body.sequence < state.sequence) {
    throw new Error(
      `${name} sequence ${body.sequence} is older than the last accepted ${state.sequence}; refusing the rollback`
    );
  }
  return { signed: true, sequence: body.sequence, body, warnings: [] };
}

export async function loadVerifiedRegistryIndex(input: {
  name: string;
  read: (suffix: '' | '.sig') => Promise<Buffer>;
  store: RegistryIndexStateStore;
  policy: RegistrySignaturePolicy;
  now?: Date;
  keys?: string[];
  remember?: (verified: VerifiedRegistryIndex) => Partial<RegistryIndexState>;
}): Promise<VerifiedRegistryIndex> {
  const raw = await input.read('');
  let signature: string | null = null;
  try {
    signature = (await input.read('.sig')).toString('utf8');
  } catch (err) {
    if (!(err instanceof MissingRegistryObject)) throw err;
  }
  const state = await input.store.load(input.name);
  const verified = verifyRegistryIndex({ ...input, raw, signature, state });
  await input.store.save(input.name, {
    ...(state?.revoked ? { revoked: state.revoked } : {}),
    sequence: verified.sequence ?? state?.sequence ?? 0,
    signed: verified.signed || state?.signed === true,
    ...(input.remember?.(verified) ?? {})
  });
  return verified;
}
