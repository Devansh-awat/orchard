import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SECRETS_ENCRYPTION_KEY = 'secret-redaction-test-key';

import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import {
  maskConnectionPassword,
  redactDatabaseForViewer,
  sealDatabaseCredentials,
  stripR2ProxyCreds
} from '../src/projects/projects.utils';
import { DatabasesService } from '../src/projects/databases.service';
import {
  redactSecretParameters,
  sealTemplateEnv,
  secretParameterValues
} from '../src/templates/templates.service';
import { mergeEnvForPut } from '../src/ai-chat/tools';

const crypto = new SecretCryptoService();

const ROW = {
  id: 'db1',
  name: 'main',
  host: 'main-rw.ns.svc',
  port: 5432,
  dbName: 'app',
  dbUser: 'app',
  dbPassword: crypto.seal('hunter2hunter2'),
  connectionString: 'postgresql://app:hunter2hunter2@main-rw.ns.svc:5432/app',
  publicConnectionString:
    'postgresql://app:hunter2hunter2@db.example.com:31000/app?sslmode=require',
  r2ProxyAccessKey: 'ak',
  r2ProxySecret: 'sk',
  r2RestoreAccessKey: 'rak',
  r2RestoreSecret: 'rsk',
  creator: { email: 'a@b.c' }
};

test('connection strings lose their password', () => {
  assert.equal(
    maskConnectionPassword('postgresql://app:p%40ss:w@host:5432/app'),
    'postgresql://app:****@host:5432/app'
  );
  assert.equal(maskConnectionPassword(null), null);
  assert.equal(maskConnectionPassword('postgresql://host/app'), 'postgresql://host/app');
});

test('editors get no password, a passwordSet flag, and masked connection strings', () => {
  const out = sealDatabaseCredentials(ROW);
  assert.equal(out.dbPassword, null);
  assert.equal(out.passwordSet, true);
  assert.equal(out.connectionString, 'postgresql://app:****@main-rw.ns.svc:5432/app');
  assert.ok(!JSON.stringify(out).includes('hunter2'));
  assert.equal(out.r2RestoreAccessKey, null);
  assert.equal(out.r2RestoreSecret, null);
  assert.equal(out.r2ProxySecret, null);
});

test('restore credentials are stripped everywhere', () => {
  const stripped = stripR2ProxyCreds(ROW);
  assert.equal(stripped.r2RestoreAccessKey, null);
  assert.equal(stripped.r2RestoreSecret, null);
  const viewer = redactDatabaseForViewer(ROW);
  assert.equal(viewer.r2RestoreSecret, null);
  assert.equal(viewer.connectionString, null);
  assert.equal(viewer.creator?.email, null);
});

function databases(audits: unknown[]) {
  const svc = Object.create(DatabasesService.prototype) as DatabasesService;
  Object.assign(svc, {
    crypto,
    prisma: {
      database: {
        findUnique: async () => ({
          ...ROW,
          publicEnabled: true,
          publicIp: '203.0.113.5',
          publicPort: 31000,
          mode: 'cnpg',
          clusterName: 'main',
          namespace: 'ns'
        })
      }
    },
    k8sCnpg: { publicTlsHostname: () => 'main.db.example.com' },
    access: {
      assertDatabaseEditor: async () => ({
        user: { id: 'u1', email: 'u@x' },
        database: { id: 'db1', name: 'main', project: { id: 'p1', organizationId: 'o1' } }
      })
    },
    audit: { log: async (entry: unknown) => audits.push(entry) }
  });
  return svc;
}

test('the connection endpoint returns plaintext and writes an audit event', async () => {
  const audits: any[] = [];
  const out = await databases(audits).revealDatabaseConnection('db1', 'clerk');
  assert.deepEqual(out, {
    host: 'main-rw.ns.svc',
    port: 5432,
    user: 'app',
    password: 'hunter2hunter2',
    database: 'app',
    connectionString: 'postgresql://app:hunter2hunter2@main-rw.ns.svc:5432/app',
    publicConnectionString:
      'postgresql://app:hunter2hunter2@main.db.example.com:31000/app?sslmode=verify-full&sslrootcert=system'
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'database.credentials.revealed');
  assert.equal(audits[0].targetId, 'db1');
});

test('secret template parameters are redacted on read', () => {
  const defs = [
    { name: 'appName', type: 'string' as const },
    { name: 'adminPassword', type: 'secret' as const }
  ];
  assert.deepEqual(redactSecretParameters({ appName: 'blog', adminPassword: 'pw123' }, defs), {
    appName: 'blog',
    adminPassword: null
  });
  assert.deepEqual(secretParameterValues({ appName: 'blog', adminPassword: 'pw123' }, defs), [
    'pw123'
  ]);
});

test('template env carrying secret material is created secret', () => {
  const env = sealTemplateEnv(
    [
      { key: 'DATABASE_URL', value: 'postgresql://app:dbpw@h/app' },
      { key: 'ADMIN_PASS', value: 'pw123' },
      { key: 'SITE_NAME', value: 'blog' }
    ],
    ['dbpw', 'pw123']
  );
  assert.deepEqual(env, [
    { key: 'DATABASE_URL', value: 'postgresql://app:dbpw@h/app', secret: true },
    { key: 'ADMIN_PASS', value: 'pw123', secret: true },
    { key: 'SITE_NAME', value: 'blog' }
  ]);
});

test('ai chat env merge keeps sealed values by sending null and never unseals', () => {
  const out = mergeEnvForPut(
    [
      { key: 'API_TOKEN', value: null, secret: true },
      { key: 'PORT', value: '3000', secret: false }
    ],
    [
      { key: 'PORT', value: '8080' },
      { key: 'API_TOKEN', value: 'rotated' },
      { key: 'NEW', value: 'x', secret: true }
    ]
  );
  assert.deepEqual(out, [
    { key: 'API_TOKEN', value: 'rotated' },
    { key: 'PORT', value: '8080' },
    { key: 'NEW', value: 'x', secret: true }
  ]);
});
