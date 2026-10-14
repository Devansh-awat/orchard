import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { untarGz } from './tar.mjs';

export const TAP_NAME = /^[a-z][a-z0-9-]{1,31}$/;
const ID = /^[a-z][a-z0-9-]{1,47}$/;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function rawPublicKey(key) {
  return createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .subarray(12)
    .toString('base64');
}

export function keyId(publicKeyB64) {
  return createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('hex')
    .slice(0, 16);
}

function publicKeyObject(raw) {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32)
    throw new Error('tap.json publicKey must be a 32-byte ed25519 key in base64');
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, bytes]),
    format: 'der',
    type: 'spki'
  });
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function compareSemver(a, b) {
  const split = (v) => {
    const [core, pre = ''] = v.split('+')[0].split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function readTap(dir) {
  const path = join(dir, 'tap.json');
  if (!existsSync(path)) throw new Error(`${dir} is not a tap: no tap.json (run graft tap init)`);
  const tap = JSON.parse(readFileSync(path, 'utf8'));
  if (!TAP_NAME.test(tap.name ?? '')) throw new Error('tap.json has an invalid name');
  publicKeyObject(tap.publicKey ?? '');
  return tap;
}

export function tapInit(input, { name, privateKey, description }) {
  const dir = resolve(input);
  if (!TAP_NAME.test(name ?? ''))
    throw new Error(
      'tap names are 2-32 lowercase letters, digits or dashes, starting with a letter'
    );
  if (!privateKey) throw new Error('--key is required: the private key the tap signs grafts with');
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the tap key must be ed25519');
  if (existsSync(join(dir, 'tap.json'))) throw new Error(`${dir} already has a tap.json`);
  const publicKey = rawPublicKey(privateKey);
  mkdirSync(join(dir, 'grafts'), { recursive: true });
  writeJson(join(dir, 'tap.json'), {
    name,
    ...(description ? { description } : {}),
    publicKey
  });
  const catalog = join(dir, 'grafts', 'index.json');
  if (!existsSync(catalog))
    writeJson(catalog, { generatedAt: new Date().toISOString(), grafts: [], revoked: [] });
  return { dir, name, publicKey, keyId: keyId(publicKey) };
}

function verifyArtifact(files, tapKey) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const manifestBody = byPath.get('MANIFEST.json');
  const signature = byPath.get('MANIFEST.sig');
  const graftJson = byPath.get('graft.json');
  if (!manifestBody || !graftJson)
    throw new Error('not a graft: graft.json or MANIFEST.json is missing');
  if (!signature) throw new Error('the graft is unsigned; pack it with --key <the tap key>');
  if (
    !verify(
      null,
      manifestBody,
      publicKeyObject(tapKey),
      Buffer.from(signature.toString('utf8').trim(), 'base64')
    )
  ) {
    throw new Error('the graft is not signed with this tap key');
  }
  const listed = JSON.parse(manifestBody.toString('utf8')).files ?? {};
  const present = files
    .map((f) => f.path)
    .filter((p) => p !== 'MANIFEST.json' && p !== 'MANIFEST.sig');
  for (const path of present) {
    if (!(path in listed)) throw new Error(`${path} is not covered by MANIFEST.json`);
    if (sha256(byPath.get(path)) !== listed[path])
      throw new Error(`${path} does not match its MANIFEST.json hash`);
  }
  const missing = Object.keys(listed).filter((p) => !byPath.has(p));
  if (missing.length)
    throw new Error(`files listed in MANIFEST.json are missing: ${missing.join(', ')}`);
  const manifest = JSON.parse(graftJson.toString('utf8'));
  if (!ID.test(manifest.id ?? '')) throw new Error('graft.json has an invalid id');
  if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? ''))
    throw new Error('graft.json version must be semver');
  if (!manifest.engines?.platform || !manifest.engines?.sdk)
    throw new Error('graft.json needs engines.platform and engines.sdk');
  return { manifest, graftJson, byPath };
}

export function tapAdd(input, file) {
  const dir = resolve(input);
  const tap = readTap(dir);
  const raw = readFileSync(resolve(file));
  const { manifest, graftJson, byPath } = verifyArtifact(untarGz(raw), tap.publicKey);
  const { id, version } = manifest;
  const base = `grafts/${id}/${version}/`;
  const artifactKey = `${base}${id}-${version}.graft`;
  const digest = `sha256:${sha256(raw)}`;
  const target = join(dir, artifactKey);
  if (existsSync(target) && sha256(readFileSync(target)) !== sha256(raw)) {
    throw new Error(
      `${id} ${version} is already in this tap with different content; bump the version`
    );
  }
  mkdirSync(join(dir, base), { recursive: true });
  writeFileSync(target, raw);
  writeFileSync(join(dir, `${base}graft.json`), graftJson);
  let readme;
  if (byPath.has('README.md')) {
    readme = `${base}README.md`;
    writeFileSync(join(dir, readme), byPath.get('README.md'));
  }
  let icon;
  const iconPath = [...byPath.keys()].find((p) => p.startsWith('assets/icon.'));
  if (iconPath) {
    icon = `${base}icon${iconPath.slice('assets/icon'.length)}`;
    writeFileSync(join(dir, icon), byPath.get(iconPath));
  }

  const indexPath = join(dir, 'grafts', id, 'index.json');
  const prior = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : null;
  const versions = new Map((prior?.versions ?? []).map((v) => [v.version, v]));
  const previous = versions.get(version);
  versions.set(version, {
    version,
    digest,
    url: artifactKey,
    size: raw.length,
    signed: true,
    engines: manifest.engines,
    capabilities: manifest.capabilities ?? [],
    manifest: `${base}graft.json`,
    ...(readme ? { readme } : {}),
    publishedAt: previous?.digest === digest ? previous.publishedAt : new Date().toISOString()
  });
  const sorted = [...versions.values()].sort((a, b) => compareSemver(b.version, a.version));
  const latest = sorted[0];
  const index = {
    id,
    name: manifest.name || id,
    description: manifest.description ?? '',
    publisher: manifest.publisher ?? '',
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    ...(latest.version === version && icon ? { icon } : prior?.icon ? { icon: prior.icon } : {}),
    latest: latest.version,
    versions: sorted,
    tier: 'tap'
  };
  writeJson(indexPath, index);

  const catalogPath = join(dir, 'grafts', 'index.json');
  const catalog = existsSync(catalogPath)
    ? JSON.parse(readFileSync(catalogPath, 'utf8'))
    : { grafts: [], revoked: [] };
  const grafts = (catalog.grafts ?? []).filter((g) => g.id !== id);
  grafts.push(index);
  grafts.sort((a, b) => a.id.localeCompare(b.id));
  writeJson(catalogPath, {
    generatedAt: new Date().toISOString(),
    grafts,
    revoked: catalog.revoked ?? []
  });
  return { tap: tap.name, id, version, digest, path: target };
}
