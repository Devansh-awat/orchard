import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const OFFICIAL_GRAFT_KEYS: string[] = ['b5IPbzjTG0mMm/fikc3WGi/PQhuC8cEOlt4WHodoihI='];

export type GraftTrustPolicy = 'official' | 'signed' | 'any';

export type GraftSignature = { signedBy: 'official' | 'publisher' | null; keyId: string | null };

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

export function verifyFileManifest(root: string): void {
  const manifestPath = join(root, 'MANIFEST.json');
  if (!existsSync(manifestPath)) throw new Error('MANIFEST.json is missing');
  const listed = (
    JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: Record<string, string> }
  ).files;
  if (!listed || typeof listed !== 'object') throw new Error('MANIFEST.json has no files map');
  const present = listFiles(root).filter((f) => f !== 'MANIFEST.json' && f !== 'MANIFEST.sig');
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

export function verifySignature(root: string, publisherKeys: string[]): GraftSignature {
  const sigPath = join(root, 'MANIFEST.sig');
  if (!existsSync(sigPath)) return { signedBy: null, keyId: null };
  const message = readFileSync(join(root, 'MANIFEST.json'));
  const signature = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64');
  const attempt = (keys: string[]) =>
    keys.find((k) => {
      try {
        return verify(null, message, publicKey(k), signature);
      } catch {
        return false;
      }
    });
  const official = attempt(OFFICIAL_GRAFT_KEYS);
  if (official) return { signedBy: 'official', keyId: keyId(official) };
  const publisher = attempt(publisherKeys);
  if (publisher) return { signedBy: 'publisher', keyId: keyId(publisher) };
  throw new Error('MANIFEST.sig does not verify against any trusted key');
}

export function enforceTrust(signature: GraftSignature, policy: GraftTrustPolicy): void {
  if (policy === 'any') return;
  if (policy === 'official' && signature.signedBy !== 'official') {
    throw new Error('trust policy "official" only allows grafts signed by Orchard');
  }
  if (policy === 'signed' && !signature.signedBy) {
    throw new Error(
      'graft is unsigned and the trust policy is "signed"; add its publisher key or set the policy to "any"'
    );
  }
}

export function trustPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): GraftTrustPolicy {
  const value = (env.ORCHARD_GRAFT_TRUST ?? 'signed').trim();
  if (value === 'official' || value === 'signed' || value === 'any') return value;
  throw new Error(`ORCHARD_GRAFT_TRUST must be official, signed or any (got "${value}")`);
}

export function publisherKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ORCHARD_GRAFT_KEYS ?? '')
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function verifyGraftDir(
  root: string,
  policy: GraftTrustPolicy,
  publisherKeys: string[]
): GraftSignature {
  verifyFileManifest(root);
  const signature = verifySignature(root, publisherKeys);
  enforceTrust(signature, policy);
  return signature;
}
