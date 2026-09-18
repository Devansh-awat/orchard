import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStartArgs,
  startArgsFor,
  usesRuntimeStartCommand
} from '../src/kubernetes/start-command';

test('an unset command leaves the image CMD alone', () => {
  assert.equal(resolveStartArgs(null), null);
  assert.equal(resolveStartArgs(undefined), null);
  assert.equal(resolveStartArgs(''), null);
  assert.equal(resolveStartArgs('   '), null);
});

test('a plain command is split into argv and exec\'d directly', () => {
  assert.deepEqual(resolveStartArgs('bundle exec sidekiq'), ['bundle', 'exec', 'sidekiq']);
  assert.deepEqual(resolveStartArgs('  node   server.js  '), ['node', 'server.js']);
});

test('quoted arguments survive the split', () => {
  assert.deepEqual(resolveStartArgs('npm run start -- --name "my app"'), [
    'npm',
    'run',
    'start',
    '--',
    '--name',
    'my app'
  ]);
  assert.deepEqual(resolveStartArgs("celery -A proj worker --loglevel='info'"), [
    'celery',
    '-A',
    'proj',
    'worker',
    '--loglevel=info'
  ]);
});

test('shell operators go through sh, because no argv means `a && b`', () => {
  assert.deepEqual(resolveStartArgs('bin/migrate && bin/server'), [
    '/bin/sh',
    '-c',
    'bin/migrate && bin/server'
  ]);
  assert.deepEqual(resolveStartArgs('gunicorn app:app --bind 0.0.0.0:$PORT'), [
    '/bin/sh',
    '-c',
    'gunicorn app:app --bind 0.0.0.0:$PORT'
  ]);
  assert.deepEqual(resolveStartArgs('java -jar build/libs/app*.jar'), [
    '/bin/sh',
    '-c',
    'java -jar build/libs/app*.jar'
  ]);
});

test('an explicit shell invocation is taken at its word, not wrapped twice', () => {
  assert.deepEqual(resolveStartArgs("sh -c 'bin/migrate && bin/server'"), [
    'sh',
    '-c',
    'bin/migrate && bin/server'
  ]);
  assert.deepEqual(resolveStartArgs('/bin/bash -c "exec puma -p $PORT"'), [
    '/bin/bash',
    '-c',
    'exec puma -p $PORT'
  ]);
});

test('JSON exec form is passed through verbatim', () => {
  // The unambiguous escape hatch, and the shape compose `command:` lists are
  // re-encoded into so already-split arguments are never re-split.
  assert.deepEqual(resolveStartArgs('["bundle", "exec", "sidekiq", "-q", "a b"]'), [
    'bundle',
    'exec',
    'sidekiq',
    '-q',
    'a b'
  ]);
  // A leading `[` that is not valid exec form falls through to the ordinary
  // path rather than being rejected, so `[ -f x ] && bin/server` still works.
  assert.deepEqual(resolveStartArgs('[ -f bin/server ] && bin/server'), [
    '/bin/sh',
    '-c',
    '[ -f bin/server ] && bin/server'
  ]);
});

test('an unterminated quote is handed to the shell to complain about', () => {
  assert.deepEqual(resolveStartArgs("node 'server.js"), ['/bin/sh', '-c', "node 'server.js"]);
});

test('an empty string argument is preserved rather than dropped', () => {
  assert.deepEqual(resolveStartArgs('redis-server --requirepass ""'), [
    'redis-server',
    '--requirepass',
    ''
  ]);
});

test('railpack keeps its build-time meaning and contributes no args', () => {
  assert.equal(usesRuntimeStartCommand('railpack'), false);
  assert.equal(usesRuntimeStartCommand('dockerfile'), true);
  // An image-source deployment has buildType `dockerfile` by default and no
  // builder at all, so args are the only lever it has.
  assert.equal(usesRuntimeStartCommand(null), true);

  assert.equal(startArgsFor({ buildType: 'railpack', startCommand: 'npm run start' }), null);
  assert.deepEqual(startArgsFor({ buildType: 'dockerfile', startCommand: 'npm run start' }), [
    'npm',
    'run',
    'start'
  ]);
});
