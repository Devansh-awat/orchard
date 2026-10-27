import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(packageRoot, 'src/agent-search.ts');
const target = resolve(packageRoot, '../../apps/server/src/agent-spec/agent-search.ts');

copyFileSync(source, target);
console.log(`synced ${source} -> ${target}`);
