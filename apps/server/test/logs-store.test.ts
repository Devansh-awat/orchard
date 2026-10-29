import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLevels, decodeLogCursor, encodeLogCursor } from '../src/logs/logs.service';
import { rowsToEntries } from '../src/logs/entries';
import { parseJsonLines } from '../src/logs/victoria-logs.service';
import { parseRange } from '../src/logs/logs.controller';

test('cursors round-trip and reject junk', () => {
  assert.equal(decodeLogCursor(encodeLogCursor(1730000000123)), 1730000000123);
  assert.equal(decodeLogCursor('not-a-cursor'), null);
  assert.equal(decodeLogCursor(Buffer.from('{"end":"x"}').toString('base64url')), null);
  assert.equal(decodeLogCursor(null), null);
});

test('levels are lower-cased and unknown ones dropped', () => {
  assert.deepEqual(cleanLevels(['ERROR', ' warn ', 'bogus', 'info']), ['error', 'warn', 'info']);
  assert.deepEqual(cleanLevels(undefined), []);
});

test('jsonl parsing skips broken lines', () => {
  assert.deepEqual(parseJsonLines('{"a":"1"}\nnot json\n\n{"b":"2"}\n'), [{ a: '1' }, { b: '2' }]);
});

test('stored rows fold stack traces per pod and come back newest first', () => {
  const rows = [
    { _time: '2026-10-28T10:00:00.000000000Z', _msg: 'Error: boom', pod: 'api-1', level: 'error' },
    {
      _time: '2026-10-28T10:00:00.000000100Z',
      _msg: '    at handler (/app/index.js:4:9)',
      pod: 'api-1'
    },
    {
      _time: '2026-10-28T10:00:05.000000000Z',
      _msg: 'listening on 3000',
      pod: 'api-2',
      level: 'info'
    }
  ];
  const entries = rowsToEntries(rows);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].metadata?.pod, 'api-2');
  assert.equal(entries[1].metadata?.pod, 'api-1');
  assert.equal(entries[1].lines.length, 2);
  assert.match(entries[1].raw, /at handler/);
});

test('ranges default to the last hour and are bounded', () => {
  const { start, end } = parseRange(undefined, '7200000');
  assert.equal(end - start, 3600000);
  assert.throws(() => parseRange('10', '5'));
  assert.throws(() => parseRange('1', String(40 * 24 * 3600 * 1000)));
});
