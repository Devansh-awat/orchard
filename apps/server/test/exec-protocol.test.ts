import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClientFrame,
  parseHandshake,
  rejectionCloseCode,
  statusFrame
} from '../src/kubernetes/exec-protocol';

test('a handshake without sizes falls back to 80x24 on protocol 1', () => {
  assert.deepEqual(parseHandshake(new URLSearchParams('namespace=x')), {
    proto: 1,
    cols: 80,
    rows: 24
  });
});

test('a v2 handshake carries the browser size, clamped to sane bounds', () => {
  assert.deepEqual(parseHandshake(new URLSearchParams('proto=2&cols=183&rows=41')), {
    proto: 2,
    cols: 183,
    rows: 41
  });
  assert.deepEqual(parseHandshake(new URLSearchParams('proto=2&cols=1&rows=0')), {
    proto: 2,
    cols: 2,
    rows: 1
  });
  assert.deepEqual(parseHandshake(new URLSearchParams('proto=2&cols=99999&rows=abc')), {
    proto: 2,
    cols: 1000,
    rows: 24
  });
  assert.equal(parseHandshake(new URLSearchParams('proto=3')).proto, 1);
});

test('binary frames are stdin bytes, untouched', () => {
  const bytes = Buffer.from([0x1b, 0x5b, 0x41]);
  assert.deepEqual(parseClientFrame(bytes, true), { kind: 'stdin', data: bytes });
  assert.deepEqual(parseClientFrame(bytes, undefined), { kind: 'stdin', data: bytes });
});

test('JSON control frames are typed and unknown types are ignored', () => {
  assert.deepEqual(
    parseClientFrame('{"type":"resize","cols":120.7,"rows":40,"force":true}', false),
    {
      kind: 'resize',
      cols: 120,
      rows: 40
    }
  );
  assert.deepEqual(parseClientFrame('{"type":"input","data":"ls\\r"}', false), {
    kind: 'stdin',
    data: 'ls\r'
  });
  assert.deepEqual(parseClientFrame('{"type":"wat"}', false), { kind: 'ignore' });
});

test('text that is not a control frame still reaches stdin for old CLI clients', () => {
  assert.deepEqual(parseClientFrame("exec psql 'postgres://x'\n", false), {
    kind: 'stdin',
    data: "exec psql 'postgres://x'\n"
  });
  assert.deepEqual(parseClientFrame('{not json', false), { kind: 'stdin', data: '{not json' });
  assert.deepEqual(parseClientFrame(Buffer.from('plain'), false), { kind: 'stdin', data: 'plain' });
});

test('HTTP rejections map onto permanent websocket close codes', () => {
  assert.equal(rejectionCloseCode(400), 4400);
  assert.equal(rejectionCloseCode(401), 4401);
  assert.equal(rejectionCloseCode(403), 4403);
  assert.equal(rejectionCloseCode(404), 4404);
  assert.equal(rejectionCloseCode(500), 1011);
});

test('status frames are JSON control frames the client renders outside the buffer', () => {
  assert.deepEqual(JSON.parse(statusFrame('revoked', 'Session terminated: access revoked.')), {
    type: 'status',
    kind: 'revoked',
    message: 'Session terminated: access revoked.'
  });
});
