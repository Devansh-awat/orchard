import { readFileSync, writeFileSync } from 'node:fs';
import { compareVersions, satisfies } from './semver.mjs';

export const DEFAULT_MARKETPLACE_URL = 'https://assets.orchard.my/registry';

const KEY = /^(\s*)(-\s+)?([A-Za-z_][\w-]*):(.*)$/;
const POLICY = /#\s*(\{.*"\$graftpolicy".*\})\s*$/;

function keyAt(line) {
  const m = KEY.exec(line);
  if (!m) return null;
  return { col: m[1].length + (m[2]?.length ?? 0), dash: !!m[2], key: m[3], rest: m[4] };
}

function scalar(rest) {
  return rest
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
}

function skippable(line) {
  return /^\s*(#.*)?$/.test(line);
}

function entryFields(lines, at, col) {
  const fields = {};
  const record = (i, k) => (fields[k.key] = { line: i, value: scalar(k.rest) });
  const self = keyAt(lines[at]);
  record(at, self);
  if (!self.dash) {
    for (let i = at - 1; i >= 0; i--) {
      if (skippable(lines[i])) continue;
      const k = keyAt(lines[i]);
      if (!k || k.col < col) break;
      if (k.col > col) continue;
      record(i, k);
      if (k.dash) break;
    }
  }
  for (let i = at + 1; i < lines.length; i++) {
    if (skippable(lines[i])) continue;
    const k = keyAt(lines[i]);
    if (!k) {
      if (lines[i].search(/\S/) > col) continue;
      break;
    }
    if (k.col > col) continue;
    if (k.col < col || k.dash) break;
    record(i, k);
  }
  return fields;
}

export function findPolicies(text) {
  const lines = text.split('\n');
  const entries = [];
  lines.forEach((line, i) => {
    const k = keyAt(line);
    if (!k || k.key !== 'version') return;
    const marker = POLICY.exec(line);
    if (!marker) return;
    let policy;
    try {
      policy = JSON.parse(marker[1]).$graftpolicy;
    } catch {
      throw new Error(`line ${i + 1}: the $graftpolicy marker is not valid JSON`);
    }
    if (typeof policy !== 'string' || !policy.trim())
      throw new Error(`line ${i + 1}: $graftpolicy must be a version range such as "^1"`);
    const fields = entryFields(lines, i, k.col);
    entries.push({
      id: fields.id?.value,
      version: fields.version.value,
      policy,
      versionLine: i,
      digestLine: fields.digest?.line,
      tap: fields.tap?.value,
      source: fields.source?.value
    });
  });
  return entries;
}

function normaliseDigest(digest) {
  return `sha256:${String(digest)
    .replace(/^sha256:/, '')
    .toLowerCase()}`;
}

export function pickVersion(listing, { current, policy, platform, revoked }) {
  const newer = (listing?.versions ?? [])
    .filter((v) => v && typeof v.version === 'string' && typeof v.digest === 'string')
    .filter((v) => v.signed !== false)
    .filter((v) => !revoked?.has(normaliseDigest(v.digest)))
    .filter((v) => satisfies(v.version, policy))
    .filter((v) => compareVersions(v.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const fits = (v) => !platform || satisfies(platform, v.engines?.platform ?? '*');
  const pick = newer.find(fits) ?? null;
  const held = newer.find(
    (v) => !fits(v) && (!pick || compareVersions(v.version, pick.version) > 0)
  );
  return { pick, held: held ?? null };
}

export async function bumpText(text, { platform, listing, revoked }) {
  const lines = text.split('\n');
  const result = { changes: [], held: [], skipped: [] };
  for (const entry of findPolicies(text)) {
    if (!entry.id) {
      result.skipped.push({
        id: '?',
        reason: `no id next to the version on line ${entry.versionLine + 1}`
      });
      continue;
    }
    if (entry.tap || entry.source) {
      result.skipped.push({ id: entry.id, reason: 'only marketplace grafts can follow a policy' });
      continue;
    }
    if (entry.digestLine === undefined) {
      result.skipped.push({ id: entry.id, reason: 'it has no digest line to update' });
      continue;
    }
    let index;
    try {
      index = await listing(entry.id);
    } catch (err) {
      result.skipped.push({ id: entry.id, reason: `marketplace listing failed: ${err.message}` });
      continue;
    }
    const { pick, held } = pickVersion(index, {
      current: entry.version,
      policy: entry.policy,
      platform,
      revoked
    });
    if (held)
      result.held.push({
        id: entry.id,
        version: held.version,
        needs: held.engines?.platform ?? ''
      });
    if (!pick) continue;
    lines[entry.versionLine] = lines[entry.versionLine].replace(
      /(version:\s*["']?)[^"'\s#]+/,
      `$1${pick.version}`
    );
    lines[entry.digestLine] = lines[entry.digestLine].replace(
      /(digest:\s*["']?)[^"'\s#]+/,
      `$1${normaliseDigest(pick.digest)}`
    );
    result.changes.push({
      id: entry.id,
      from: entry.version,
      to: pick.version,
      digest: normaliseDigest(pick.digest)
    });
  }
  return { text: lines.join('\n'), ...result };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function bumpFiles(files, { platform, marketplace, check }) {
  const base = (marketplace || DEFAULT_MARKETPLACE_URL).replace(/\/+$/, '');
  const catalog = await fetchJson(`${base}/grafts/index.json`);
  const revoked = new Set((catalog.revoked ?? []).map(normaliseDigest));
  const listings = new Map();
  const listing = (id) => {
    if (!listings.has(id)) listings.set(id, fetchJson(`${base}/grafts/${id}/index.json`));
    return listings.get(id);
  };
  const reports = [];
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const report = await bumpText(before, { platform, listing, revoked });
    if (!check && report.text !== before) writeFileSync(file, report.text);
    reports.push({ file, ...report });
  }
  return reports;
}
