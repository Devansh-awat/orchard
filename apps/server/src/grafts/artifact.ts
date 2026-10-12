import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest, type GraftManifest } from './manifest';
import { extractTarGz } from './untar';

export function digestOf(archive: Buffer): string {
  return `sha256:${createHash('sha256').update(archive).digest('hex')}`;
}

export function readArtifactManifest(archive: Buffer): GraftManifest {
  const dir = mkdtempSync(join(tmpdir(), 'graft-artifact-'));
  try {
    extractTarGz(archive, dir);
    return parseManifest(JSON.parse(readFileSync(join(dir, 'graft.json'), 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
