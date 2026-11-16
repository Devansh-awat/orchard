import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUntrustedYaml } from '../src/security/untrusted-yaml';
import { parseScore } from '../src/score/score-parse';

const bomb = [
  'a: &a [x, x, x, x, x, x, x, x, x, x]',
  'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
  'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
  'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
  'services:',
  '  web:',
  '    image: nginx',
  '    environment: [*d]'
].join('\n');

test('a document that reuses a list through an alias is refused before anything walks it', () => {
  const started = Date.now();
  assert.throws(() => loadUntrustedYaml(bomb), /aliases to lists or maps/);
  assert.ok(Date.now() - started < 1000);
});

test('aliases to plain scalars and ordinary compose files still load', () => {
  const doc = loadUntrustedYaml(
    ['x: &port 8080', 'services:', '  web:', '    image: nginx', '    ports: [*port]'].join('\n')
  ) as any;
  assert.deepEqual(doc.services.web.ports, [8080]);
});

test('a document with too many nodes is refused', () => {
  const big = `items: [${Array.from({ length: 2000 }, (_, i) => i).join(', ')}]`;
  assert.throws(() => loadUntrustedYaml(big, 1000), /more than 1000 nodes/);
  assert.equal((loadUntrustedYaml(big) as any).items.length, 2000);
});

test('a score file built as an alias bomb is treated as no score file', () => {
  const score = ['apiVersion: score.dev/v1b1', 'metadata: {name: web}', bomb].join('\n');
  assert.equal(parseScore(score), null);
});
