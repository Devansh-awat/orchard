import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const OFFICIAL_GRAFT_KEYS: string[] = ['b5IPbzjTG0mMm/fikc3WGi/PQhuC8cEOlt4WHodoihI='];

export type GraftTrustPolicy = 'official' | 'listed' | 'taps' | 'any';

export type GraftTier = 'official' | 'community' | 'tap' | 'publisher';

export type GraftSignature = {
  tier: GraftTier | null;
  keyId: string | null;
  publisher?: string;
  repo?: string;
  tap?: string;
  signedBy: 'official' | 'publisher' | null;
};

export type GraftTap = { name: string; url: string; key: string };

export type GraftOrigin = { source: 'marketplace' | 'tap' | 'url' | 'stored'; tap?: string };

export type GraftTrust = { policy: GraftTrustPolicy; keys: string[]; taps: GraftTap[] };

export type GraftListing = {
  id: string;
  tier: 'community' | 'delisted';
  publisher: string;
  repo: string;
  homepage?: string;
  keys: string[];
  listedAt: string;
};

export const ORIGIN_FILE = '.origin.json';
export const LISTING_FILE = '.listing.json';
export const LISTING_SIG_FILE = '.listing.json.sig';
export const TAP_NAME = /^[a-z][a-z0-9-]{1,31}$/;

const POLICY_ALLOWS: Record<GraftTrustPolicy, (GraftTier | null)[]> = {
  official: ['official'],
  listed: ['official', 'community', 'publisher'],
  taps: ['official', 'community', 'publisher', 'tap'],
  any: ['official', 'community', 'publisher', 'tap', null]
};

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function keyId(publicKeyB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('hex')
    .slice(0, 16);
}

function publicKey(raw: string) {
  const bytes = Buffer.from(raw.trim(), 'base64');
  if (bytes.length !== 32)
    throw new Error('graft public keys must be 32-byte ed25519 keys in base64');
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, bytes]),
    format: 'der',
    type: 'spki'
  });
}

function isPublicKey(raw: unknown): raw is string {
  return typeof raw === 'string' && Buffer.from(raw.trim(), 'base64').length === 32;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink())
        throw new Error(`graft contains a symlink: ${relative(root, full)}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function recordedBySync(file: string): boolean {
  return file.startsWith('.origin.') || file.startsWith('.listing.');
}

export function verifyFileManifest(root: string): void {
  const manifestPath = join(root, 'MANIFEST.json');
  if (!existsSync(manifestPath)) throw new Error('MANIFEST.json is missing');
  const listed = (
    JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: Record<string, string> }
  ).files;
  if (!listed || typeof listed !== 'object') throw new Error('MANIFEST.json has no files map');
  const present = listFiles(root).filter(
    (f) => f !== 'MANIFEST.json' && f !== 'MANIFEST.sig' && !recordedBySync(f)
  );
  const missing = Object.keys(listed).filter((f) => !present.includes(f));
  if (missing.length)
    throw new Error(`files listed in MANIFEST.json are missing: ${missing.join(', ')}`);
  const unlisted = present.filter((f) => !(f in listed));
  if (unlisted.length)
    throw new Error(`files not covered by MANIFEST.json: ${unlisted.join(', ')}`);
  for (const file of present) {
    if (sha256File(join(root, file)) !== listed[file]) {
      throw new Error(`file ${file} does not match its MANIFEST.json hash`);
    }
  }
}

export function signedWith(
  message: Buffer,
  signatureB64: string,
  keys: string[]
): string | undefined {
  const signature = Buffer.from(signatureB64.trim(), 'base64');
  return keys.find((k) => {
    try {
      return verify(null, message, publicKey(k), signature);
    } catch {
      return false;
    }
  });
}

export function signedByOrchard(root: string): boolean {
  const sigPath = join(root, 'MANIFEST.sig');
  if (!existsSync(sigPath)) return false;
  return !!signedWith(
    readFileSync(join(root, 'MANIFEST.json')),
    readFileSync(sigPath, 'utf8'),
    OFFICIAL_GRAFT_KEYS
  );
}

export function readOrigin(root: string): GraftOrigin | null {
  const path = join(root, ORIGIN_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GraftOrigin>;
    if (!raw.source || !['marketplace', 'tap', 'url', 'stored'].includes(raw.source)) return null;
    return { source: raw.source, ...(typeof raw.tap === 'string' ? { tap: raw.tap } : {}) };
  } catch {
    return null;
  }
}

export function parseListing(body: Buffer | string): GraftListing {
  const raw = JSON.parse(body.toString()) as Partial<GraftListing>;
  if (
    typeof raw.id !== 'string' ||
    (raw.tier !== 'community' && raw.tier !== 'delisted') ||
    typeof raw.publisher !== 'string' ||
    typeof raw.repo !== 'string' ||
    !Array.isArray(raw.keys) ||
    !raw.keys.every(isPublicKey)
  ) {
    throw new Error('the marketplace listing is malformed');
  }
  return {
    id: raw.id,
    tier: raw.tier,
    publisher: raw.publisher,
    repo: raw.repo,
    ...(typeof raw.homepage === 'string' ? { homepage: raw.homepage } : {}),
    keys: raw.keys,
    listedAt: typeof raw.listedAt === 'string' ? raw.listedAt : ''
  };
}

function verifiedListing(root: string): { listing: GraftListing | null; problem?: string } {
  const listingPath = join(root, LISTING_FILE);
  const sigPath = join(root, LISTING_SIG_FILE);
  if (!existsSync(listingPath) || !existsSync(sigPath)) {
    return { listing: null, problem: 'it has no Extension Marketplace listing' };
  }
  const body = readFileSync(listingPath);
  if (!signedWith(body, readFileSync(sigPath, 'utf8'), OFFICIAL_GRAFT_KEYS)) {
    return { listing: null, problem: 'its marketplace listing is not signed by Orchard' };
  }
  try {
    return { listing: parseListing(body) };
  } catch (err) {
    return { listing: null, problem: (err as Error).message };
  }
}

function graftId(root: string): string | null {
  try {
    const id = (JSON.parse(readFileSync(join(root, 'graft.json'), 'utf8')) as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

const unsigned = (): GraftSignature => ({ tier: null, keyId: null, signedBy: null });

export function decideSignature(
  root: string,
  trust: Pick<GraftTrust, 'keys' | 'taps'>,
  origin: GraftOrigin | null = readOrigin(root)
): GraftSignature {
  const sigPath = join(root, 'MANIFEST.sig');
  if (!existsSync(sigPath)) return unsigned();
  const message = readFileSync(join(root, 'MANIFEST.json'));
  const signature = readFileSync(sigPath, 'utf8');
  const hints: string[] = [];

  const official = signedWith(message, signature, OFFICIAL_GRAFT_KEYS);
  if (official) return { tier: 'official', keyId: keyId(official), signedBy: 'official' };

  if (origin?.source === 'marketplace') {
    const { listing, problem } = verifiedListing(root);
    const id = graftId(root);
    if (!listing) hints.push(problem!);
    else if (listing.tier === 'delisted')
      hints.push('it was delisted from the Extension Marketplace');
    else if (listing.id !== id)
      hints.push(`its marketplace listing is for ${listing.id}, not ${id ?? 'this graft'}`);
    else {
      const key = signedWith(message, signature, listing.keys);
      if (key) {
        return {
          tier: 'community',
          keyId: keyId(key),
          publisher: listing.publisher,
          repo: listing.repo,
          signedBy: 'publisher'
        };
      }
      hints.push(`it is not signed with the key ${listing.publisher} listed`);
    }
  }

  if (origin?.source === 'tap') {
    const tap = trust.taps.find((t) => t.name === origin.tap);
    if (!tap) hints.push(`its tap ${origin.tap ?? '(unnamed)'} is not configured`);
    else if (signedWith(message, signature, [tap.key])) {
      return { tier: 'tap', keyId: keyId(tap.key), tap: tap.name, signedBy: 'publisher' };
    } else hints.push(`it is not signed with the key of the ${tap.name} tap`);
  }

  const publisher = signedWith(message, signature, trust.keys);
  if (publisher) return { tier: 'publisher', keyId: keyId(publisher), signedBy: 'publisher' };

  throw new Error(
    `MANIFEST.sig does not verify against any trusted key${hints.length ? `: ${hints.join('; ')}` : ''}`
  );
}

export function enforceTrust(signature: GraftSignature, policy: GraftTrustPolicy): void {
  if (POLICY_ALLOWS[policy].includes(signature.tier)) return;
  if (policy === 'official') {
    throw new Error('trust policy "official" only allows grafts signed by Orchard');
  }
  if (signature.tier === null) {
    throw new Error(
      `graft is unsigned and the trust policy is "${policy}"; add its publisher key or set the policy to "any"`
    );
  }
  throw new Error(
    `graft comes from the ${signature.tap} tap and the trust policy is "${policy}"; set it to "taps" to allow taps`
  );
}

export function trustPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): GraftTrustPolicy {
  const value = (env.ORCHARD_GRAFT_TRUST || 'listed').trim();
  if (value === 'signed') return 'listed';
  if (value === 'official' || value === 'listed' || value === 'taps' || value === 'any')
    return value;
  throw new Error(`ORCHARD_GRAFT_TRUST must be official, listed, taps or any (got "${value}")`);
}

export function publisherKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ORCHARD_GRAFT_KEYS ?? '')
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function tapsFromEnv(env: NodeJS.ProcessEnv = process.env): GraftTap[] {
  const raw = env.ORCHARD_GRAFT_TAPS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ORCHARD_GRAFT_TAPS must be a JSON array of { name, url, key }');
  }
  if (!Array.isArray(parsed))
    throw new Error('ORCHARD_GRAFT_TAPS must be a JSON array of { name, url, key }');
  const taps: GraftTap[] = [];
  for (const entry of parsed as Partial<GraftTap>[]) {
    const name = entry?.name;
    if (typeof name !== 'string' || !TAP_NAME.test(name))
      throw new Error(`ORCHARD_GRAFT_TAPS has an invalid tap name ${JSON.stringify(name)}`);
    if (taps.some((t) => t.name === name))
      throw new Error(`ORCHARD_GRAFT_TAPS lists the ${name} tap twice`);
    if (typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url))
      throw new Error(`ORCHARD_GRAFT_TAPS: tap ${name} needs an http(s) url`);
    if (!isPublicKey(entry.key))
      throw new Error(`ORCHARD_GRAFT_TAPS: tap ${name} needs a 32-byte ed25519 key in base64`);
    taps.push({ name, url: entry.url.replace(/\/+$/, ''), key: entry.key.trim() });
  }
  return taps;
}

export function graftTrustFromEnv(env: NodeJS.ProcessEnv = process.env): GraftTrust {
  return {
    policy: trustPolicyFromEnv(env),
    keys: publisherKeysFromEnv(env),
    taps: tapsFromEnv(env)
  };
}

export function verifyGraftDir(root: string, trust: GraftTrust): GraftSignature {
  verifyFileManifest(root);
  const signature = decideSignature(root, trust);
  enforceTrust(signature, trust.policy);
  return signature;
}
