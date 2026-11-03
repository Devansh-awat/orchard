import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const chart = resolve(__dirname, '../../../infra/charts/orchard');

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function render(sets: string[]): string {
  const args = ['template', 'orchard', chart, '--namespace', 'orchard'];
  for (const s of sets) args.push('--set', s);
  return execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function deployment(out: string, name: string): string {
  return (
    out
      .split(/^---$/m)
      .find((d) => /kind: Deployment/.test(d) && new RegExp(`name: ${name}\\n`).test(d)) ?? ''
  );
}

const skip = !helmAvailable();

test('status and vanity hosts route to the frontend in the release namespace', { skip }, () => {
  const env = deployment(render(['namespace=paas', 'frontend.service.port=3100']), 'server');
  assert.match(env, /name: PLATFORM_NAMESPACE, value: "paas"/);
  assert.match(env, /name: PLATFORM_SERVICE_NAME, value: "frontend"/);
  assert.match(env, /name: PLATFORM_SERVICE_PORT, value: "3100"/);
});

test('an operator supplying env from a Secret keeps its platform target', { skip }, () => {
  const out = render([
    'server.envFrom[0].secretRef.name=orchard-server-env',
    'server.env[0].name=BASE_DOMAIN',
    'server.env[0].value=orchard.my'
  ]);
  assert.doesNotMatch(deployment(out, 'server'), /PLATFORM_(NAMESPACE|SERVICE_NAME|SERVICE_PORT)/);
  assert.doesNotMatch(deployment(out, 'frontend'), /PUBLIC_BASE_DOMAIN|PUBLIC_PLATFORM_ORIGIN/);
});

test('a platform target set in server.env is not rendered twice', { skip }, () => {
  const env = deployment(
    render(['server.env[0].name=PLATFORM_NAMESPACE', 'server.env[0].value=elsewhere']),
    'server'
  );
  assert.equal((env.match(/PLATFORM_NAMESPACE/g) ?? []).length, 1);
  assert.match(env, /value: elsewhere/);
});

test('the frontend learns the vanity domain and where the api really is', { skip }, () => {
  assert.doesNotMatch(
    deployment(render([]), 'frontend'),
    /PUBLIC_BASE_DOMAIN|PUBLIC_PLATFORM_ORIGIN/
  );
  const env = deployment(
    render([
      'server.env[0].name=BASE_DOMAIN',
      'server.env[0].value=apps.example.com',
      'server.env[1].name=FRONTEND_URL',
      'server.env[1].value=https://orchard.example.com'
    ]),
    'frontend'
  );
  assert.match(env, /name: PUBLIC_BASE_DOMAIN, value: "apps.example.com"/);
  assert.match(env, /name: PUBLIC_PLATFORM_ORIGIN, value: "https:\/\/orchard.example.com"/);
});
