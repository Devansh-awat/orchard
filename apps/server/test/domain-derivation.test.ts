import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as path from 'path';

// PLATFORM_WILDCARD_DOMAINS is resolved once at module load, so each case has
// to run in its own process to see a different environment.
function resolve(env: Record<string, string>) {
  const script = `
    import { PLATFORM_WILDCARD_DOMAINS, isPlatformGeneratedHost } from ${JSON.stringify(path.join(__dirname, '../src/projects/projects.utils'))};
    process.stdout.write(JSON.stringify({
      domains: PLATFORM_WILDCARD_DOMAINS,
      generated: isPlatformGeneratedHost('main-forge-16294e.apps.example.com'),
      hackclub: isPlatformGeneratedHost('main-forge-16294e.k.hackclub.dev'),
    }));
  `;
  const out = execFileSync('pnpm', ['exec', 'tsx', '-e', script], {
    env: { ...process.env, PLATFORM_WILDCARD_DOMAINS: '', APP_DOMAIN: '', ...env },
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

// The suffix is derived so URLs can be generated; the secret is NOT, because
// nothing on a stock install creates a wildcard Secret. Naming one here made
// every generated URL point at a Secret that never existed, so the host served
// no certificate at all. A null secret sends callers down the per-host issuance
// path instead, which works out of the box.
test('derives the wildcard suffix from APP_DOMAIN, with no secret', () => {
  const r = resolve({ APP_DOMAIN: 'apps.example.com' });
  assert.deepEqual(r.domains, [{ suffix: '.apps.example.com', secret: null }]);
  assert.equal(r.generated, true);
});

test('an unconfigured instance generates nothing rather than falling back to a literal', () => {
  const r = resolve({});
  assert.deepEqual(r.domains, []);
  assert.equal(r.hackclub, false);
});

test('explicit PLATFORM_WILDCARD_DOMAINS wins over APP_DOMAIN and supports multiple entries', () => {
  const r = resolve({
    APP_DOMAIN: 'ignored.example.com',
    PLATFORM_WILDCARD_DOMAINS: '.a.example.com=sec-a,.b.example.com=sec-b'
  });
  assert.deepEqual(r.domains, [
    { suffix: '.a.example.com', secret: 'sec-a' },
    { suffix: '.b.example.com', secret: 'sec-b' }
  ]);
});

test('a bare entry keeps a null secret, and a missing leading dot is added', () => {
  const r = resolve({ PLATFORM_WILDCARD_DOMAINS: 'apps.example.com' });
  assert.deepEqual(r.domains, [{ suffix: '.apps.example.com', secret: null }]);
});

// Hosts under a suffix are still recognised as platform-generated when there is
// no wildcard secret: that is what tells "has a URL" from "has a custom domain",
// and it must not depend on how TLS happens to be issued.
test('host matching is unaffected by the absence of a secret', () => {
  const r = resolve({ APP_DOMAIN: 'apps.example.com' });
  assert.equal(r.generated, true);
  assert.equal(r.hackclub, false);
});

// The optional public-hostname features must never guess a domain under
// APP_DOMAIN: each needs its own DNS and wildcard cert, so a derived
// `db.<appDomain>` would resolve nowhere and have no certificate.
function optionalFor(env: Record<string, string>) {
  const script = `
    import { optionalDomain } from ${JSON.stringify(path.join(__dirname, '../src/env/platform-domains'))};
    process.stdout.write(JSON.stringify({
      db: optionalDomain(process.env.PUBLIC_DB_DOMAIN),
      port: optionalDomain(process.env.PUBLIC_DEPLOYMENT_DOMAIN),
      vanity: optionalDomain(process.env.BASE_DOMAIN),
    }));
  `;
  const out = execFileSync('pnpm', ['exec', 'tsx', '-e', script], {
    env: {
      ...process.env,
      APP_DOMAIN: '',
      PUBLIC_DB_DOMAIN: '',
      PUBLIC_DEPLOYMENT_DOMAIN: '',
      BASE_DOMAIN: '',
      ...env
    },
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

test('optional domains stay empty when only APP_DOMAIN is set', () => {
  assert.deepEqual(optionalFor({ APP_DOMAIN: 'apps.example.com' }), {
    db: '',
    port: '',
    vanity: ''
  });
});

test('optional domains are used verbatim when set, and normalised', () => {
  assert.deepEqual(
    optionalFor({
      APP_DOMAIN: 'apps.example.com',
      PUBLIC_DB_DOMAIN: '.DB.example.com.',
      PUBLIC_DEPLOYMENT_DOMAIN: 'ports.example.com',
      BASE_DOMAIN: 'example.com'
    }),
    { db: 'db.example.com', port: 'ports.example.com', vanity: 'example.com' }
  );
});

// The vanity domain is its own fact. On the Hack Club cluster the UI is served
// from orchard.infra.hackclub.com, apps land on k.hackclub.dev, and org vanity
// hosts sit under orchard.my — so it can be derived from neither FRONTEND_URL
// nor APP_DOMAIN, and an unset BASE_DOMAIN has to mean "off".
function vanityFor(env: Record<string, string>) {
  const script = `
    import { optionalDomain } from ${JSON.stringify(path.join(__dirname, '../src/env/platform-domains'))};
    process.stdout.write(optionalDomain(process.env.BASE_DOMAIN));
  `;
  return execFileSync('pnpm', ['exec', 'tsx', '-e', script], {
    env: { ...process.env, BASE_DOMAIN: '', FRONTEND_URL: '', APP_DOMAIN: '', ...env },
    encoding: 'utf8'
  });
}

test('vanity domain is never guessed from the platform host or the app domain', () => {
  assert.equal(
    vanityFor({ FRONTEND_URL: 'https://orchard.infra.hackclub.com', APP_DOMAIN: 'k.hackclub.dev' }),
    ''
  );
});

test('vanity domain is used verbatim when set, and normalised', () => {
  assert.equal(
    vanityFor({ BASE_DOMAIN: 'Orchard.My.', FRONTEND_URL: 'https://orchard.infra.hackclub.com' }),
    'orchard.my'
  );
});
