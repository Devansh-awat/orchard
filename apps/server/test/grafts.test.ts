import 'reflect-metadata';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Client } from 'pg';
import { satisfies } from '../src/grafts/semver';
import { resolveClaims, canUseName } from '../src/grafts/claims';
import {
  verifyGraftDir,
  listFiles,
  sha256File,
  type GraftTrustPolicy
} from '../src/grafts/integrity';
import { createTar, extractTarGz } from '../src/grafts/untar';
import { parseManifest } from '../src/grafts/manifest';
import { loadGrafts } from '../src/grafts/loader';
import { applyMigrations, readMigrations } from '../src/grafts/migrations';
import { platformVersion } from '../src/grafts/host-api';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function baseManifest(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    version: '1.0.0',
    publisher: 'tests',
    engines: { platform: '>=0.0.0', sdk: '^1.0.0' },
    ...extra
  };
}

function writeGraft(
  root: string,
  id: string,
  files: Record<string, string>,
  manifest: Record<string, unknown>
) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'graft.json'), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function seal(dir: string, privateKey?: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const files = Object.fromEntries(
    listFiles(dir)
      .filter((f) => f !== 'MANIFEST.json' && f !== 'MANIFEST.sig')
      .map((f) => [f, sha256File(join(dir, f))])
  );
  const body = Buffer.from(JSON.stringify({ files }));
  writeFileSync(join(dir, 'MANIFEST.json'), body);
  if (privateKey)
    writeFileSync(join(dir, 'MANIFEST.sig'), sign(null, body, privateKey).toString('base64'));
}

function rawPublicKey(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(12)
    .toString('base64');
}

const SERVER_MODULE = (routes: string) => `
const { Controller, Get, Post, Module, SetMetadata } = require('@nestjs/common');
class ThingsController { ping() { return { ok: true }; } secret() { return {}; } hook() { return {}; } }
Reflect.decorate([Controller('things')], ThingsController);
${routes}
class GraftModule {}
Reflect.decorate([Module({ controllers: [ThingsController] })], GraftModule);
module.exports = { default: GraftModule };
`;

const decorate = (method: string, verb: string, path: string, meta: string[] = []) =>
  `Reflect.decorate([${verb}('${path}')${meta.map((m) => `, ${m}`).join('')}], ThingsController.prototype, '${method}', Object.getOwnPropertyDescriptor(ThingsController.prototype, '${method}'));`;

describe('semver ranges', () => {
  test('caret, tilde, comparators and alternatives', () => {
    assert.ok(satisfies('1.4.2', '^1.0.0'));
    assert.ok(!satisfies('2.0.0', '^1.0.0'));
    assert.ok(satisfies('0.3.9', '^0.3.1'));
    assert.ok(!satisfies('0.4.0', '^0.3.1'));
    assert.ok(satisfies('2.70.0', '>=2.70 <3'));
    assert.ok(!satisfies('3.0.0', '>=2.70 <3'));
    assert.ok(satisfies('1.2.9', '~1.2.0'));
    assert.ok(!satisfies('1.3.0', '~1.2.0'));
    assert.ok(satisfies('5.1.0', '^4.0.0 || ^5.0.0'));
    assert.ok(satisfies('1.2.3', '*'));
    assert.ok(satisfies('1.2.3', '1.2.x'));
    assert.ok(!satisfies('1.3.0', '1.2.x'));
  });
});

describe('manifest', () => {
  test('rejects reserved ids and unknown fields', () => {
    assert.throws(() => parseManifest(baseManifest('admin')), /reserved/);
    assert.throws(
      () => parseManifest({ ...baseManifest('ok-id'), surprise: true }),
      /Unrecognized key/
    );
    assert.equal(parseManifest(baseManifest('ok-id')).runtime, 'native');
  });
});

describe('claims', () => {
  test('own names are free, aliases are first come, owners beat aliases, core beats everyone', () => {
    const a = parseManifest(
      baseManifest('alpha', {
        claims: { apiAliases: ['sandboxes', 'beta-ish'], notificationEvents: ['alpha.done'] }
      })
    );
    const b = parseManifest(
      baseManifest('beta', { claims: { apiAliases: ['sandboxes/sub', 'reports'] } })
    );
    const resolved = resolveClaims([a, b], { apiAliases: (v) => v === 'reports' });
    const alpha = resolved.get('alpha')!;
    const beta = resolved.get('beta')!;
    assert.equal(alpha.find((c) => c.value === 'sandboxes')!.state, 'alias');
    assert.equal(alpha.find((c) => c.value === 'alpha.done')!.state, 'own');
    assert.equal(beta.find((c) => c.value === 'sandboxes/sub')!.state, 'shadowed');
    assert.equal(beta.find((c) => c.value === 'reports')!.shadowedBy, 'core');
    assert.ok(canUseName('alpha', alpha, 'notificationEvents', 'alpha.anything'));
    assert.ok(!canUseName('beta', beta, 'apiAliases', 'sandboxes/sub'));
  });
});

describe('integrity and trust', () => {
  test('signed, unsigned and tampered grafts against each policy', () => {
    const root = tmp('graft-integrity');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = rawPublicKey(publicKey);
    const trust = (policy: GraftTrustPolicy, keys: string[]) => ({ policy, keys, taps: [] });
    const signed = writeGraft(
      root,
      'signed',
      { 'server/index.js': 'module.exports={}' },
      baseManifest('signed')
    );
    seal(signed, privateKey);
    assert.equal(verifyGraftDir(signed, trust('listed', [key])).signedBy, 'publisher');
    assert.throws(() => verifyGraftDir(signed, trust('official', [key])), /official/);
    assert.throws(() => verifyGraftDir(signed, trust('listed', [])), /does not verify/);

    const unsigned = writeGraft(root, 'unsigned', { 'a.txt': 'x' }, baseManifest('unsigned'));
    seal(unsigned);
    assert.throws(() => verifyGraftDir(unsigned, trust('listed', [key])), /unsigned/);
    assert.equal(verifyGraftDir(unsigned, trust('any', [])).signedBy, null);

    writeFileSync(join(signed, 'server/index.js'), 'module.exports={evil:true}');
    assert.throws(() => verifyGraftDir(signed, trust('listed', [key])), /does not match/);
    writeFileSync(join(unsigned, 'extra.js'), '');
    assert.throws(() => verifyGraftDir(unsigned, trust('any', [])), /not covered/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('archive extraction', () => {
  test('round trips long paths and refuses unsafe entries', () => {
    const dest = tmp('graft-untar');
    const long = `ui/${'deep/'.repeat(25)}file.js`;
    const archive = gzipSync(
      createTar([
        { path: 'graft.json', content: Buffer.from('{}') },
        { path: long, content: Buffer.from('hello') }
      ])
    );
    const entries = extractTarGz(archive, dest);
    assert.equal(entries.length, 2);
    assert.equal(readFileSync(join(dest, long), 'utf8'), 'hello');

    const evil = (name: string) => {
      const tar = createTar([{ path: 'ok.txt', content: Buffer.from('x') }]);
      tar.write(name.padEnd(100, '\0'), 0, 'utf8');
      let sum = 0;
      tar.write('        ', 148, 'ascii');
      for (const byte of tar.subarray(0, 512)) sum += byte;
      tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
      return gzipSync(tar);
    };
    assert.throws(() => extractTarGz(evil('../escape.txt'), tmp('graft-evil')), /unsafe path/);
    assert.throws(() => extractTarGz(evil('/etc/passwd'), tmp('graft-evil')), /absolute path/);
    assert.throws(() => extractTarGz(evil('.env'), tmp('graft-evil')), /dotfile/);
    rmSync(dest, { recursive: true, force: true });
  });
});

describe('loader', () => {
  test('loads good grafts and contains every kind of failure', async () => {
    const root = tmp('graft-loader');
    const env = { ORCHARD_GRAFT_TRUST: 'any', ORCHARD_GRAFTS_DIR: root } as NodeJS.ProcessEnv;
    const routes = [
      decorate('ping', 'Get', 'ping', ["SetMetadata('isPublic', true)"]),
      decorate('secret', 'Get', 'secret')
    ].join('\n');

    const good = writeGraft(
      root,
      'good',
      { 'server/index.js': SERVER_MODULE(routes) },
      baseManifest('good', {
        entries: { server: 'server/index.js' },
        public: { routes: ['GET /things/ping'] }
      })
    );
    writeFileSync(
      join(good, 'routes.json'),
      JSON.stringify({ 'GET /things/ping': 'public', 'GET /things/secret': 'superadmin' })
    );
    seal(good);

    const sneaky = writeGraft(
      root,
      'sneaky',
      { 'server/index.js': SERVER_MODULE(routes) },
      baseManifest('sneaky', {
        entries: { server: 'server/index.js' }
      })
    );
    seal(sneaky);

    const drifted = writeGraft(
      root,
      'drifted',
      { 'server/index.js': SERVER_MODULE(routes) },
      baseManifest('drifted', {
        entries: { server: 'server/index.js' },
        public: { routes: ['GET /things/ping'] }
      })
    );
    writeFileSync(join(drifted, 'routes.json'), JSON.stringify({ 'GET /things/ping': 'public' }));
    seal(drifted);

    writeGraft(root, 'tampered', { 'a.js': 'x' }, baseManifest('tampered'));
    seal(join(root, 'tampered'));
    writeFileSync(join(root, 'tampered', 'a.js'), 'y');

    const future = writeGraft(
      root,
      'future',
      {},
      baseManifest('future', { engines: { platform: '>=99.0.0', sdk: '^1.0.0' } })
    );
    seal(future);
    const needsDoor = writeGraft(
      root,
      'needs-door',
      {},
      baseManifest('needs-door', { uses: { auth: 7 } })
    );
    seal(needsDoor);
    const orphan = writeGraft(
      root,
      'orphan',
      {},
      baseManifest('orphan', { requires: { grafts: { missing: '^1.0.0' } } })
    );
    seal(orphan);
    const dependent = writeGraft(
      root,
      'dependent',
      {},
      baseManifest('dependent', { requires: { grafts: { good: '^1.0.0' } } })
    );
    seal(dependent);
    const throws = writeGraft(
      root,
      'throws',
      { 'server/index.js': 'throw new Error("kaboom")' },
      baseManifest('throws', {
        entries: { server: 'server/index.js' }
      })
    );
    seal(throws);
    writeGraft(root, 'badjson', {}, { id: 'badjson' });

    const records = await loadGrafts({ dir: root, env, migrate: false });
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    assert.equal(byId.good.status, 'loaded');
    assert.deepEqual(byId.good.routes!.map((r) => `${r.key} ${r.classification}`).sort(), [
      'GET /things/ping public',
      'GET /things/secret superadmin'
    ]);
    assert.equal(byId.dependent.status, 'loaded');
    const expectFail = (id: string, phase: string, pattern: RegExp) => {
      assert.equal(byId[id].status, 'failed', `${id} should fail`);
      assert.equal(byId[id].phase, phase, `${id} phase`);
      assert.match(byId[id].reason!, pattern);
    };
    expectFail('sneaky', 'routes', /public routes not declared/);
    expectFail('drifted', 'routes', /differ from routes.json/);
    expectFail('tampered', 'integrity', /does not match/);
    expectFail('future', 'compat', /needs Orchard >=99/);
    expectFail('needs-door', 'compat', /auth@7/);
    expectFail('orphan', 'dependencies', /not installed/);
    expectFail('throws', 'load', /kaboom/);
    expectFail('badjson', 'manifest', /invalid graft.json/);
    assert.ok(platformVersion());

    await assert.rejects(
      loadGrafts({ dir: root, env: { ...env, ORCHARD_GRAFTS_STRICT: '1' }, migrate: false }),
      /ORCHARD_GRAFTS_STRICT/
    );
    assert.equal(
      (await loadGrafts({ dir: root, env: { ...env, ORCHARD_GRAFTS_SAFE_MODE: '1' } })).length,
      0
    );
    rmSync(root, { recursive: true, force: true });
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const hasPostgres = spawnSync('initdb', ['--version']).status === 0;

describe('migrations', { skip: hasPostgres ? false : 'initdb not on PATH' }, () => {
  let dataDir = '';
  let port = 0;
  let client: Client;

  before(async () => {
    dataDir = tmp('graft-pg');
    port = await freePort();
    execFileSync('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
    execFileSync(
      'pg_ctl',
      ['-D', dataDir, '-o', `-p ${port} -k ${dataDir} -c listen_addresses=''`, '-w', 'start'],
      { stdio: 'ignore' }
    );
    client = new Client({ host: dataDir, port, user: 'postgres', database: 'postgres' });
    await client.connect();
    const ledger = readFileSync(
      join(__dirname, '../prisma/migrations/20261012120000_graft_migrations/migration.sql'),
      'utf8'
    );
    await client.query(ledger);
  });

  after(async () => {
    await client?.end().catch(() => undefined);
    if (dataDir) {
      spawnSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  function graftWith(migrations: Record<string, string>): string {
    const dir = tmp('graft-mig');
    for (const [name, sql] of Object.entries(migrations)) {
      mkdirSync(join(dir, 'migrations', name), { recursive: true });
      writeFileSync(join(dir, 'migrations', name, 'migration.sql'), sql);
    }
    return dir;
  }

  const tables = async (schema: string) =>
    (
      await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1',
        [schema]
      )
    ).rows.map((r) => r.table_name);

  test('a failing migration leaves the schema exactly as it was', async () => {
    const dir = graftWith({
      '001_init': 'CREATE TABLE notes (id serial primary key, body text);',
      '002_broken': 'CREATE TABLE more (id serial); SELECT definitely_not_a_function();'
    });
    await assert.rejects(
      applyMigrations(client, 'atomic', readMigrations(dir)),
      /002_broken failed/
    );
    assert.deepEqual(await tables('ext_atomic'), []);
    const ledger = await client.query(
      "SELECT count(*)::int AS n FROM graft_migrations WHERE graft_id = 'atomic'"
    );
    assert.equal(ledger.rows[0].n, 0);
  });

  test('dry run reports success and changes nothing', async () => {
    const dir = graftWith({ '001_init': 'CREATE TABLE notes (id serial primary key);' });
    const result = await applyMigrations(client, 'dry', readMigrations(dir), { dryRun: true });
    assert.deepEqual(result.applied, ['001_init']);
    assert.deepEqual(await tables('ext_dry'), []);
    await assert.rejects(
      applyMigrations(client, 'dry', readMigrations(graftWith({ '001_init': 'SELECT nope();' })), {
        dryRun: true
      }),
      /001_init failed/
    );
  });

  test('applies once, refuses edited history, refuses missing history', async () => {
    const dir = graftWith({ '001_init': 'CREATE TABLE notes (id serial primary key);' });
    assert.deepEqual((await applyMigrations(client, 'ledger', readMigrations(dir))).applied, [
      '001_init'
    ]);
    assert.deepEqual((await applyMigrations(client, 'ledger', readMigrations(dir))).applied, []);
    assert.deepEqual(await tables('ext_ledger'), ['notes']);
    const edited = graftWith({ '001_init': 'CREATE TABLE notes (id bigserial primary key);' });
    await assert.rejects(
      applyMigrations(client, 'ledger', readMigrations(edited)),
      /checksum mismatch/
    );
    await assert.rejects(applyMigrations(client, 'ledger', []), /missing from this version/);
  });

  test('no-transaction migrations run on their own', async () => {
    const dir = graftWith({
      '001_init': 'CREATE TABLE notes (id serial primary key, body text);',
      '002_index': '-- graft:no-transaction\nCREATE INDEX CONCURRENTLY notes_body ON notes (body);'
    });
    assert.deepEqual((await applyMigrations(client, 'concurrent', readMigrations(dir))).applied, [
      '001_init',
      '002_index'
    ]);
    const idx = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'ext_concurrent'"
    );
    assert.ok(idx.rows.some((r) => r.indexname === 'notes_body'));
    await assert.rejects(
      applyMigrations(client, 'concurrent-dry', readMigrations(dir), { dryRun: true }),
      /cannot rehearse 002_index/
    );
  });

  test('checksums are stable sha256 of migration.sql', () => {
    const dir = graftWith({ '001_init': 'SELECT 1;' });
    assert.equal(
      readMigrations(dir)[0].checksum,
      createHash('sha256').update('SELECT 1;').digest('hex')
    );
    assert.ok(existsSync(join(dir, 'migrations')));
  });
});

describe('boot', () => {
  test('aliases forward to grafts, core wins, and a graft that breaks DI is dropped', async () => {
    const { Controller, Get, Module } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { createWithGrafts, graftImports, installApiAliases } =
      await import('../src/grafts/boot');
    const { graftRecords } = await import('../src/grafts/graft-registry');

    const root = tmp('graft-boot');
    const env = { ORCHARD_GRAFTS_DEV: '1' } as NodeJS.ProcessEnv;
    const aliasRoutes = `
const { Controller, Get, Module } = require('@nestjs/common');
class SandboxesController { list() { return { from: 'graft' }; } owned() { return { from: 'graft' }; } }
Reflect.decorate([Controller('sandboxes')], SandboxesController);
Reflect.decorate([Get()], SandboxesController.prototype, 'list', Object.getOwnPropertyDescriptor(SandboxesController.prototype, 'list'));
Reflect.decorate([Get('owned')], SandboxesController.prototype, 'owned', Object.getOwnPropertyDescriptor(SandboxesController.prototype, 'owned'));
class GraftModule {}
Reflect.decorate([Module({ controllers: [SandboxesController] })], GraftModule);
module.exports = { default: GraftModule };`;
    writeGraft(
      root,
      'greenhouse',
      { 'server/index.js': aliasRoutes },
      baseManifest('greenhouse', {
        entries: { server: 'server/index.js' },
        claims: { apiAliases: ['sandboxes'] }
      })
    );
    const broken = `
const { Controller, Get, Module, Injectable, Inject } = require('@nestjs/common');
class NeedsMissing { constructor(dep) { this.dep = dep; } }
Reflect.decorate([Injectable()], NeedsMissing);
Inject('DefinitelyNotProvided')(NeedsMissing, undefined, 0);
class BrokenController { constructor(svc) { this.svc = svc; } hi() { return 1; } }
Reflect.decorate([Controller('x'), Reflect.metadata('design:paramtypes', [NeedsMissing])], BrokenController);
Reflect.decorate([Get()], BrokenController.prototype, 'hi', Object.getOwnPropertyDescriptor(BrokenController.prototype, 'hi'));
class BrokenGraftModule {}
Reflect.decorate([Module({ controllers: [BrokenController], providers: [NeedsMissing] })], BrokenGraftModule);
module.exports = { default: BrokenGraftModule };`;
    writeGraft(
      root,
      'broken',
      { 'server/index.js': broken },
      baseManifest('broken', { entries: { server: 'server/index.js' } })
    );

    await loadGrafts({ dir: root, env, migrate: false });

    class CoreController {
      owned() {
        return { from: 'core' };
      }
    }
    Reflect.decorate([Controller('sandboxes')], CoreController);
    Reflect.decorate(
      [Get('owned')],
      CoreController.prototype,
      'owned',
      Object.getOwnPropertyDescriptor(CoreController.prototype, 'owned')!
    );
    class CoreModule {}
    Reflect.decorate([Module({ controllers: [CoreController] })], CoreModule);

    const app = await createWithGrafts((grafts) =>
      NestFactory.create(
        { module: CoreModule, imports: graftImports(grafts) },
        { logger: false, abortOnError: false }
      )
    );
    app.setGlobalPrefix('apiv1');
    installApiAliases(app);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as { port: number }).port;
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    };
    try {
      assert.deepEqual(await get('/apiv1/greenhouse/sandboxes'), {
        status: 200,
        body: { from: 'graft' }
      });
      assert.deepEqual(await get('/apiv1/sandboxes'), { status: 200, body: { from: 'graft' } });
      assert.deepEqual(await get('/apiv1/sandboxes/owned'), {
        status: 200,
        body: { from: 'core' }
      });
      assert.deepEqual(await get('/apiv1/greenhouse/sandboxes/owned'), {
        status: 200,
        body: { from: 'graft' }
      });
      assert.equal((await get('/apiv1/broken/x')).status, 404);
      const brokenRecord = graftRecords().find((r) => r.id === 'broken')!;
      assert.equal(brokenRecord.status, 'failed');
      assert.equal(brokenRecord.phase, 'boot');
      assert.equal(graftRecords().find((r) => r.id === 'greenhouse')!.status, 'loaded');
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sync', () => {
  test('downloads, verifies and unpacks pinned artifacts; reports failures to the loader', async () => {
    const { syncGrafts } = await import('../src/grafts/sync');
    const work = tmp('graft-sync');
    const src = writeGraft(work, 'notes', { 'server/readme.txt': 'hi' }, baseManifest('notes'));
    seal(src);
    const files = listFiles(src).map((path) => ({ path, content: readFileSync(join(src, path)) }));
    const artifact = gzipSync(createTar(files));
    const artifactPath = join(work, 'notes-1.0.0.graft');
    writeFileSync(artifactPath, artifact);
    const digest = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
    const dest = join(work, 'installed');
    const env = (grafts: unknown[]) =>
      ({
        ORCHARD_GRAFTS: JSON.stringify(grafts),
        ORCHARD_GRAFTS_DIR: dest,
        ORCHARD_GRAFT_TRUST: 'any',
        ORCHARD_GRAFT_MARKETPLACE_URL: join(work, 'no-marketplace')
      }) as NodeJS.ProcessEnv;

    const ok = await syncGrafts(
      env([{ id: 'notes', version: '1.0.0', source: `file://${artifactPath}`, digest }])
    );
    assert.deepEqual(ok.synced, ['notes']);
    assert.deepEqual(ok.failed, []);
    assert.match(ok.warnings[0], /revoked versions were not checked/);
    assert.equal(readFileSync(join(dest, 'notes', 'server/readme.txt'), 'utf8'), 'hi');

    const bad = await syncGrafts(
      env([
        { id: 'notes', version: '1.0.0', source: `file://${artifactPath}`, digest: 'sha256:00' },
        { id: 'other', version: '1.0.0', source: `file://${artifactPath}`, digest },
        { id: 'nodigest', version: '1.0.0', source: `file://${artifactPath}` }
      ])
    );
    assert.deepEqual(bad.synced, []);
    assert.match(bad.failed.find((f) => f.id === 'notes')!.reason, /digest mismatch/);
    assert.match(bad.failed.find((f) => f.id === 'other')!.reason, /artifact is graft notes/);
    assert.match(bad.failed.find((f) => f.id === 'nodigest')!.reason, /digest is required/);

    const records = await loadGrafts({
      dir: dest,
      env: { ORCHARD_GRAFT_TRUST: 'any' } as NodeJS.ProcessEnv,
      migrate: false
    });
    const other = records.find((r) => r.id === 'other')!;
    assert.equal(other.status, 'failed');
    assert.equal(other.phase, 'sync');
    rmSync(work, { recursive: true, force: true });
  });
});

describe('trust tiers', () => {
  type Pair = ReturnType<typeof generateKeyPairSync>;
  const orchard = generateKeyPairSync('ed25519');
  const orchardKey = rawPublicKey(orchard.publicKey);
  const author = generateKeyPairSync('ed25519');
  const authorKey = rawPublicKey(author.publicKey);
  const stranger = generateKeyPairSync('ed25519');
  const tapPair = generateKeyPairSync('ed25519');
  const tapKey = rawPublicKey(tapPair.publicKey);
  let integrity: typeof import('../src/grafts/integrity');

  before(async () => {
    integrity = await import('../src/grafts/integrity');
    integrity.OFFICIAL_GRAFT_KEYS.push(orchardKey);
  });

  after(() => {
    const at = integrity.OFFICIAL_GRAFT_KEYS.indexOf(orchardKey);
    if (at !== -1) integrity.OFFICIAL_GRAFT_KEYS.splice(at, 1);
  });

  const trust = (policy: GraftTrustPolicy, extra: Record<string, unknown> = {}) => ({
    policy,
    keys: [] as string[],
    taps: [] as { name: string; url: string; key: string }[],
    ...extra
  });

  function listingBody(id: string, extra: Record<string, unknown> = {}) {
    return Buffer.from(
      JSON.stringify({
        id,
        tier: 'community',
        publisher: 'acme',
        repo: 'acme/orchard-notes',
        homepage: 'https://github.com/acme/orchard-notes',
        keys: [authorKey],
        listedAt: '2026-10-14T00:00:00Z',
        ...extra
      })
    );
  }

  function writeListing(dir: string, body: Buffer, signer: Pair['privateKey']) {
    writeFileSync(join(dir, '.listing.json'), body);
    writeFileSync(
      join(dir, '.listing.json.sig'),
      `${sign(null, body, signer).toString('base64')}\n`
    );
  }

  function graft(root: string, id: string, signer?: Pair['privateKey'], origin?: object) {
    const dir = writeGraft(root, id, { 'server/readme.txt': id }, baseManifest(id));
    seal(dir, signer);
    if (origin) writeFileSync(join(dir, '.origin.json'), JSON.stringify(origin));
    return dir;
  }

  function artifact(dir: string): Buffer {
    return gzipSync(
      createTar(
        listFiles(dir)
          .filter((f) => !f.startsWith('.'))
          .map((path) => ({ path, content: readFileSync(join(dir, path)) }))
      )
    );
  }

  const digestOf = (archive: Buffer) =>
    `sha256:${createHash('sha256').update(archive).digest('hex')}`;

  test('official grafts load under every policy', () => {
    const root = tmp('graft-tier');
    const dir = graft(root, 'core-thing', orchard.privateKey, { source: 'url' });
    for (const policy of ['official', 'listed', 'taps', 'any'] as const) {
      const sig = verifyGraftDir(dir, trust(policy));
      assert.equal(sig.tier, 'official');
      assert.equal(sig.signedBy, 'official');
      assert.equal(sig.keyId, integrity.keyId(orchardKey));
    }
    rmSync(root, { recursive: true, force: true });
  });

  test('community grafts need a listing Orchard signed for this id and key', () => {
    const root = tmp('graft-tier');
    const origin = { source: 'marketplace' };
    const dir = graft(root, 'notes', author.privateKey, origin);
    writeListing(dir, listingBody('notes'), orchard.privateKey);
    const sig = verifyGraftDir(dir, trust('listed'));
    assert.deepEqual(sig, {
      tier: 'community',
      keyId: integrity.keyId(authorKey),
      publisher: 'acme',
      repo: 'acme/orchard-notes',
      signedBy: 'publisher'
    });
    assert.throws(() => verifyGraftDir(dir, trust('official')), /official/);

    const forged = graft(root, 'forged', author.privateKey, origin);
    writeListing(forged, listingBody('forged'), stranger.privateKey);
    assert.throws(() => verifyGraftDir(forged, trust('any')), /not signed by Orchard/);

    const delisted = graft(root, 'gone', author.privateKey, origin);
    writeListing(delisted, listingBody('gone', { tier: 'delisted' }), orchard.privateKey);
    assert.throws(() => verifyGraftDir(delisted, trust('any')), /delisted/);

    const borrowed = graft(root, 'borrowed', author.privateKey, origin);
    writeListing(borrowed, listingBody('notes'), orchard.privateKey);
    assert.throws(() => verifyGraftDir(borrowed, trust('any')), /listing is for notes/);

    const resigned = graft(root, 'resigned', stranger.privateKey, origin);
    writeListing(resigned, listingBody('resigned'), orchard.privateKey);
    assert.throws(() => verifyGraftDir(resigned, trust('any')), /not signed with the key acme/);

    const elsewhere = graft(root, 'elsewhere', author.privateKey, { source: 'url' });
    writeListing(elsewhere, listingBody('elsewhere'), orchard.privateKey);
    assert.throws(() => verifyGraftDir(elsewhere, trust('any')), /does not verify/);

    writeFileSync(join(dir, 'server/readme.txt'), 'tampered');
    assert.throws(() => verifyGraftDir(dir, trust('listed')), /does not match/);
    rmSync(root, { recursive: true, force: true });
  });

  test('tap grafts need the tap configured with its key and a taps policy', () => {
    const root = tmp('graft-tier');
    const taps = [{ name: 'acme', url: 'https://acme.dev/orchard', key: tapKey }];
    const dir = graft(root, 'notes', tapPair.privateKey, { source: 'tap', tap: 'acme' });
    const sig = verifyGraftDir(dir, trust('taps', { taps }));
    assert.deepEqual(sig, {
      tier: 'tap',
      keyId: integrity.keyId(tapKey),
      tap: 'acme',
      signedBy: 'publisher'
    });
    assert.equal(verifyGraftDir(dir, trust('any', { taps })).tier, 'tap');
    assert.throws(() => verifyGraftDir(dir, trust('listed', { taps })), /set it to "taps"/);
    assert.throws(() => verifyGraftDir(dir, trust('official', { taps })), /official/);
    assert.throws(() => verifyGraftDir(dir, trust('any')), /tap acme is not configured/);
    const otherKey = rawPublicKey(stranger.publicKey);
    assert.throws(
      () => verifyGraftDir(dir, trust('any', { taps: [{ ...taps[0], key: otherKey }] })),
      /not signed with the key of the acme tap/
    );
    rmSync(root, { recursive: true, force: true });
  });

  test('publisher keys load under listed, unsigned only under any', () => {
    const root = tmp('graft-tier');
    const keyed = graft(root, 'keyed', author.privateKey, { source: 'stored' });
    const sig = verifyGraftDir(keyed, trust('listed', { keys: [authorKey] }));
    assert.equal(sig.tier, 'publisher');
    assert.equal(sig.keyId, integrity.keyId(authorKey));
    assert.throws(() => verifyGraftDir(keyed, trust('listed')), /does not verify/);

    const bare = graft(root, 'bare', undefined, { source: 'url' });
    for (const policy of ['official', 'listed', 'taps'] as const) {
      assert.throws(() => verifyGraftDir(bare, trust(policy)), /unsigned|official/);
    }
    assert.deepEqual(verifyGraftDir(bare, trust('any')), {
      tier: null,
      keyId: null,
      signedBy: null
    });
    rmSync(root, { recursive: true, force: true });
  });

  test('signed is listed, and taps come from the environment', () => {
    assert.equal(integrity.trustPolicyFromEnv({ ORCHARD_GRAFT_TRUST: 'signed' }), 'listed');
    assert.equal(integrity.trustPolicyFromEnv({}), 'listed');
    assert.throws(() => integrity.trustPolicyFromEnv({ ORCHARD_GRAFT_TRUST: 'yolo' }), /taps/);
    assert.deepEqual(
      integrity.tapsFromEnv({
        ORCHARD_GRAFT_TAPS: JSON.stringify([{ name: 'acme', url: 'https://a.dev/t/', key: tapKey }])
      }),
      [{ name: 'acme', url: 'https://a.dev/t', key: tapKey }]
    );
    assert.throws(
      () => integrity.tapsFromEnv({ ORCHARD_GRAFT_TAPS: '[{"name":"A","url":"https://x"}]' }),
      /invalid tap name/
    );
    assert.throws(
      () =>
        integrity.tapsFromEnv({
          ORCHARD_GRAFT_TAPS: JSON.stringify([{ name: 'acme', url: 'https://x', key: 'nope' }])
        }),
      /ed25519/
    );
  });

  test('sync records the origin, fetches listings, refuses revoked digests', async () => {
    const { syncGrafts } = await import('../src/grafts/sync');
    const work = tmp('graft-tier-sync');
    const market = join(work, 'market');
    const src = graft(join(work, 'src'), 'notes', author.privateKey);
    const archive = artifact(src);
    mkdirSync(join(market, 'grafts/notes/1.0.0'), { recursive: true });
    writeFileSync(join(market, 'grafts/notes/1.0.0/notes-1.0.0.graft'), archive);
    const listing = listingBody('notes');
    writeFileSync(join(market, 'grafts/notes/listing.json'), listing);
    writeFileSync(
      join(market, 'grafts/notes/listing.json.sig'),
      `${sign(null, listing, orchard.privateKey).toString('base64')}\n`
    );
    const catalog = (revoked: string[]) =>
      writeFileSync(
        join(market, 'grafts/index.json'),
        JSON.stringify({ generatedAt: '', grafts: [], revoked })
      );
    catalog([]);
    const dest = join(work, 'installed');
    const env = (trustPolicy: string) =>
      ({
        ORCHARD_GRAFTS: JSON.stringify([
          { id: 'notes', version: '1.0.0', digest: digestOf(archive) }
        ]),
        ORCHARD_GRAFTS_DIR: dest,
        ORCHARD_GRAFT_TRUST: trustPolicy,
        ORCHARD_GRAFT_MARKETPLACE_URL: market,
        ORCHARD_REGISTRY_SIGNATURE: 'auto'
      }) as NodeJS.ProcessEnv;

    const ok = await syncGrafts(env('signed'));
    assert.deepEqual(ok, { synced: ['notes'], failed: [], warnings: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(dest, 'notes/.origin.json'), 'utf8')), {
      source: 'marketplace'
    });
    assert.ok(existsSync(join(dest, 'notes/.listing.json.sig')));
    const records = await loadGrafts({ dir: dest, env: env('listed'), migrate: false });
    assert.equal(records[0].status, 'loaded');
    assert.equal(records[0].signature?.tier, 'community');
    assert.equal(records[0].signature?.publisher, 'acme');

    const official = await syncGrafts(env('official'));
    assert.match(official.failed[0].reason, /official/);

    catalog([digestOf(archive).toUpperCase().replace('SHA256:', '')]);
    const revoked = await syncGrafts(env('any'));
    assert.deepEqual(revoked.synced, []);
    assert.match(revoked.failed[0].reason, /revoked by the Extension Marketplace/);
    rmSync(work, { recursive: true, force: true });
  });

  test('sync downloads tap grafts from the tap and checks them against its key', async () => {
    const { syncGrafts } = await import('../src/grafts/sync');
    const work = tmp('graft-tier-tap');
    const tapRoot = join(work, 'tap');
    const src = graft(join(work, 'src'), 'notes', tapPair.privateKey);
    const archive = artifact(src);
    mkdirSync(join(tapRoot, 'grafts/notes/1.0.0'), { recursive: true });
    writeFileSync(join(tapRoot, 'grafts/notes/1.0.0/notes-1.0.0.graft'), archive);
    const server = createHttpServer((req, res) => {
      const path = join(tapRoot, decodeURIComponent((req.url ?? '/').split('?')[0]));
      if (!path.startsWith(tapRoot) || !existsSync(path)) return res.writeHead(404).end();
      res.writeHead(200).end(readFileSync(path));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dest = join(work, 'installed');
    const env = (taps: unknown[], spec: Record<string, unknown>, policy = 'taps') =>
      ({
        ORCHARD_GRAFTS: JSON.stringify([
          { id: 'notes', version: '1.0.0', digest: digestOf(archive), ...spec }
        ]),
        ORCHARD_GRAFTS_DIR: dest,
        ORCHARD_GRAFT_TRUST: policy,
        ORCHARD_GRAFT_TAPS: JSON.stringify(taps),
        ORCHARD_GRAFTS_ALLOW_HTTP: '1',
        ORCHARD_GRAFT_MARKETPLACE_URL: join(work, 'no-marketplace')
      }) as NodeJS.ProcessEnv;
    const tap = { name: 'acme', url, key: tapKey };
    try {
      const ok = await syncGrafts(env([tap], { tap: 'acme' }));
      assert.deepEqual(ok.synced, ['notes']);
      assert.deepEqual(JSON.parse(readFileSync(join(dest, 'notes/.origin.json'), 'utf8')), {
        source: 'tap',
        tap: 'acme'
      });
      const loaded = await loadGrafts({ dir: dest, env: env([tap], {}), migrate: false });
      assert.equal(loaded[0].signature?.tier, 'tap');

      const listed = await syncGrafts(env([tap], { tap: 'acme' }, 'listed'));
      assert.match(listed.failed[0].reason, /set it to "taps"/);
      const missing = await syncGrafts(env([], { tap: 'acme' }));
      assert.match(missing.failed[0].reason, /tap acme is not configured/);
      const wrongKey = await syncGrafts(
        env([{ ...tap, key: rawPublicKey(stranger.publicKey) }], { tap: 'acme' })
      );
      assert.match(wrongKey.failed[0].reason, /not signed with the key of the acme tap/);
      const both = await syncGrafts(env([tap], { tap: 'acme', source: `${url}/x.graft` }));
      assert.match(both.failed[0].reason, /either tap or source/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('doors', () => {
  test('doors know which graft injected them and enforce capabilities and claims', async () => {
    const { Global, Module, Scope } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { createWithGrafts, graftImports } = await import('../src/grafts/boot');
    const { graftRecords } = await import('../src/grafts/graft-registry');
    const { AuditService } = await import('../src/audit/audit.service');
    const { ContextDoorV1 } = await import('../src/grafts/doors/context.door');
    const { AuditDoorV1 } = await import('../src/grafts/doors/audit.door');
    const { doorToken } = await import('../src/grafts/doors/door');

    const logged: { action: string; metadata?: unknown }[] = [];
    class TestDoors {}
    Reflect.decorate(
      [
        Global(),
        Module({
          providers: [
            {
              provide: AuditService,
              useValue: {
                log: async (input: { action: string }) => {
                  logged.push(input);
                }
              }
            },
            { provide: doorToken('context', 1), useClass: ContextDoorV1, scope: Scope.TRANSIENT },
            { provide: doorToken('audit', 1), useClass: AuditDoorV1, scope: Scope.TRANSIENT }
          ],
          exports: [doorToken('context', 1), doorToken('audit', 1)]
        })
      ],
      TestDoors
    );

    const graftSource = (cls: string) => `
const { Module, Injectable, Inject } = require('@nestjs/common');
class ${cls} {
  constructor(ctx, audit) { this.ctx = ctx; this.audit = audit; globalThis.__doorUsers = (globalThis.__doorUsers || []).concat(this); }
}
Reflect.decorate([Injectable()], ${cls});
Inject(Symbol.for('orchard.graft.door.context@1'))(${cls}, undefined, 0);
Inject(Symbol.for('orchard.graft.door.audit@1'))(${cls}, undefined, 1);
class Sub {}
Reflect.decorate([Module({ providers: [${cls}] })], Sub);
class Root {}
Reflect.decorate([Module({ imports: [Sub] })], Root);
module.exports = { default: Root };`;

    const root = tmp('graft-doors');
    writeGraft(
      root,
      'notes',
      { 'server/index.js': graftSource('NotesService') },
      baseManifest('notes', {
        entries: { server: 'server/index.js' },
        capabilities: ['audit'],
        claims: { auditActions: ['note'] }
      })
    );
    writeGraft(
      root,
      'sneaky',
      { 'server/index.js': graftSource('SneakyService') },
      baseManifest('sneaky', {
        entries: { server: 'server/index.js' }
      })
    );
    await loadGrafts({
      dir: root,
      env: { ORCHARD_GRAFTS_DEV: '1' } as NodeJS.ProcessEnv,
      migrate: false
    });

    class Core {}
    Reflect.decorate([Module({ imports: [TestDoors] })], Core);
    (globalThis as { __doorUsers?: unknown[] }).__doorUsers = [];
    const app = await createWithGrafts((grafts) =>
      NestFactory.create(
        { module: Core, imports: graftImports(grafts) },
        { logger: false, abortOnError: false }
      )
    );
    try {
      const sneaky = graftRecords().find((r) => r.id === 'sneaky')!;
      assert.equal(sneaky.status, 'failed');
      assert.match(sneaky.reason!, /does not declare the "audit" capability/);
      const users = (
        globalThis as {
          __doorUsers: { ctx: { id: string }; audit: { log: (i: unknown) => Promise<void> } }[];
        }
      ).__doorUsers;
      const notes = users.find((u) => u.ctx.id === 'notes')!;
      assert.ok(notes);
      await notes.audit.log({ action: 'notes.created' });
      await notes.audit.log({ action: 'note.legacy' });
      await assert.rejects(
        async () => notes.audit.log({ action: 'deployment.deleted' }),
        /neither under "notes."/
      );
      assert.deepEqual(
        logged.map((l) => l.action),
        ['notes.created', 'note.legacy']
      );
      assert.deepEqual(logged[0].metadata, { graft: 'notes' });
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the storage door keeps each graft inside its own folder', async () => {
    const { Global, Module, Scope } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { createWithGrafts, graftImports } = await import('../src/grafts/boot');
    const { graftRecords } = await import('../src/grafts/graft-registry');
    const { StorageService } = await import('../src/organizations/storage.service');
    const { StorageDoorV1 } = await import('../src/grafts/doors/storage.door');
    const { doorToken } = await import('../src/grafts/doors/door');

    const saved = { ...process.env };
    Object.assign(process.env, {
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET_NAME: 'bucket',
      R2_ENDPOINT: 'https://r2.test',
      R2_PUBLIC_URL: 'https://cdn.test'
    });
    const uploads: { folder: string; name: string; type: string; bytes: number }[] = [];
    const deletes: string[] = [];
    class TestDoors {}
    Reflect.decorate(
      [
        Global(),
        Module({
          providers: [
            {
              provide: StorageService,
              useValue: {
                uploadFile: async (
                  file: { originalname: string; mimetype: string; buffer: Buffer },
                  folder: string
                ) => {
                  uploads.push({
                    folder,
                    name: file.originalname,
                    type: file.mimetype,
                    bytes: file.buffer.length
                  });
                  return `https://cdn.test/${folder}/uuid.${file.originalname.split('.').pop()}`;
                },
                deleteFile: async (url: string) => {
                  deletes.push(url);
                }
              }
            },
            { provide: doorToken('storage', 1), useClass: StorageDoorV1, scope: Scope.TRANSIENT }
          ],
          exports: [doorToken('storage', 1)]
        })
      ],
      TestDoors
    );

    const graftSource = (cls: string) => `
const { Module, Injectable, Inject } = require('@nestjs/common');
class ${cls} {
  constructor(storage) { this.storage = storage; globalThis.__storageUsers = (globalThis.__storageUsers || []).concat(this); }
}
Reflect.decorate([Injectable()], ${cls});
Inject(Symbol.for('orchard.graft.door.storage@1'))(${cls}, undefined, 0);
class Root {}
Reflect.decorate([Module({ providers: [${cls}] })], Root);
module.exports = { default: Root };`;

    const root = tmp('graft-storage');
    writeGraft(
      root,
      'pics',
      { 'server/index.js': graftSource('PicsService') },
      baseManifest('pics', { entries: { server: 'server/index.js' }, capabilities: ['storage'] })
    );
    writeGraft(
      root,
      'grabby',
      { 'server/index.js': graftSource('GrabbyService') },
      baseManifest('grabby', { entries: { server: 'server/index.js' } })
    );
    await loadGrafts({
      dir: root,
      env: { ORCHARD_GRAFTS_DEV: '1' } as NodeJS.ProcessEnv,
      migrate: false
    });

    class Core {}
    Reflect.decorate([Module({ imports: [TestDoors] })], Core);
    (globalThis as { __storageUsers?: unknown[] }).__storageUsers = [];
    const app = await createWithGrafts((grafts) =>
      NestFactory.create(
        { module: Core, imports: graftImports(grafts) },
        { logger: false, abortOnError: false }
      )
    );
    try {
      const grabby = graftRecords().find((r) => r.id === 'grabby')!;
      assert.equal(grabby.status, 'failed');
      assert.match(grabby.reason!, /does not declare the "storage" capability/);

      const [pics] = (
        globalThis as {
          __storageUsers: {
            storage: {
              configured: boolean;
              publicBase: string | null;
              owns(url: string): boolean;
              upload(file: {
                data: Uint8Array;
                contentType: string;
                extension: string;
              }): Promise<string>;
              delete(url: string): Promise<void>;
            };
          }[];
        }
      ).__storageUsers;
      const { storage } = pics;
      assert.equal(storage.configured, true);
      assert.equal(storage.publicBase, 'https://cdn.test/pics/');

      const url = await storage.upload({
        data: new Uint8Array([1, 2, 3]),
        contentType: 'image/png',
        extension: 'PNG'
      });
      assert.equal(url, 'https://cdn.test/pics/uuid.png');
      assert.deepEqual(uploads, [
        { folder: 'pics', name: 'upload.png', type: 'image/png', bytes: 3 }
      ]);
      await assert.rejects(
        storage.upload({
          data: new Uint8Array(),
          contentType: 'text/html',
          extension: 'html/../x'
        }),
        /invalid file extension/
      );

      assert.equal(storage.owns(url), true);
      assert.equal(storage.owns('https://cdn.test/organizations/logo.png'), false);
      assert.equal(storage.owns('https://cdn.test/pics/../organizations/logo.png'), false);
      await storage.delete(url);
      await assert.rejects(
        storage.delete('https://cdn.test/organizations/logo.png'),
        /can only delete its own files/
      );
      assert.deepEqual(deletes, [url]);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
      process.env = saved;
    }
  });

  test('graft-api.json matches the snapshot', async () => {
    const { describeDoors } = await import('../src/grafts/doors');
    const snapshotPath = join(__dirname, 'graft-api.snapshot.json');
    const current = { doors: describeDoors() };
    if (process.env.UPDATE_SNAPSHOT === '1' || !existsSync(snapshotPath)) {
      writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + '\n');
      return;
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    for (const [door, desc] of Object.entries(
      snapshot.doors as Record<
        string,
        { status: string; methods: Record<string, number>; properties: string[] }
      >
    )) {
      const now = current.doors[door];
      assert.ok(
        now,
        `door ${door} was removed; keep it until its removeIn release or add a new version`
      );
      if (desc.status !== 'stable') continue;
      for (const [method, arity] of Object.entries(desc.methods)) {
        assert.equal(
          now.methods[method],
          arity,
          `stable door ${door} changed method ${method}; add ${door.split('@')[0]}@${Number(door.split('@')[1]) + 1} instead`
        );
      }
      for (const prop of desc.properties)
        assert.ok(now.properties.includes(prop), `stable door ${door} lost property ${prop}`);
    }
    const added = Object.keys(current.doors).filter((d) => !(d in snapshot.doors));
    assert.deepEqual(
      added,
      [],
      `new doors ${added.join(', ')}: run UPDATE_SNAPSHOT=1 pnpm test:grafts to record them`
    );
  });
});

describe('graft bump', () => {
  const values = [
    'spec:',
    '  values:',
    '    grafts:',
    '      - id: greenhouse',
    '        version: 1.0.0 # {"$graftpolicy": "^1"}',
    '        digest: sha256:aaa',
    '      - id: forum',
    '        version: \'1.1.0\' # {"$graftpolicy": "^1"}',
    '        digest: "sha256:bbb"',
    '      - version: 0.2.0 # {"$graftpolicy": ">=0.2.0 <1"}',
    '        id: announcements',
    '        digest: sha256:ccc',
    '      - id: pinned',
    '        version: 1.0.0',
    '        digest: sha256:ddd',
    '      - id: tapped',
    '        tap: acme',
    '        version: 1.0.0 # {"$graftpolicy": "^1"}',
    '        digest: sha256:eee',
    '    image:',
    '      version: 9.9.9',
    ''
  ].join('\n');

  const v = (version: string, platform: string, extra: Record<string, unknown> = {}) => ({
    version,
    digest: `sha256:${version.replace(/\./g, '')}`,
    signed: true,
    engines: { platform, sdk: '^1.0.0' },
    ...extra
  });

  const listings: Record<string, unknown> = {
    greenhouse: {
      versions: [
        v('1.1.0', '>=2.67.0 <3'),
        v('1.2.0', '>=2.67.0 <3', { signed: false }),
        v('1.3.0', '>=2.67.0 <3'),
        v('2.0.0', '>=2.67.0 <3')
      ]
    },
    forum: { versions: [v('1.2.0', '>=2.70.0 <3'), v('1.0.0', '>=2.69.0 <3')] },
    announcements: { versions: [v('0.3.0', '>=2.67.0 <3'), v('0.4.0', '>=2.67.0 <3')] }
  };

  const listing = async (id: string) => {
    if (!(id in listings)) throw new Error(`404 for ${id}`);
    return listings[id];
  };

  test('follows each policy, skips unsigned and revoked, and leaves pins alone', async () => {
    const { bumpText } = await import('../../../packages/graft-sdk/cli/bump.mjs');
    const report = await bumpText(values, {
      platform: '2.69.0',
      listing,
      revoked: new Set(['sha256:130'])
    });
    assert.deepEqual(
      report.changes.map((c: { id: string; from: string; to: string }) => [c.id, c.from, c.to]),
      [
        ['greenhouse', '1.0.0', '1.1.0'],
        ['announcements', '0.2.0', '0.4.0']
      ]
    );
    assert.deepEqual(report.held, [{ id: 'forum', version: '1.2.0', needs: '>=2.70.0 <3' }]);
    assert.deepEqual(report.skipped, [
      { id: 'tapped', reason: 'only marketplace grafts can follow a policy' }
    ]);
    const lines = report.text.split('\n');
    assert.equal(lines[4], '        version: 1.1.0 # {"$graftpolicy": "^1"}');
    assert.equal(lines[5], '        digest: sha256:110');
    assert.equal(lines[9], '      - version: 0.4.0 # {"$graftpolicy": ">=0.2.0 <1"}');
    assert.equal(lines[11], '        digest: sha256:040');
    assert.equal(lines[7], '        version: \'1.1.0\' # {"$graftpolicy": "^1"}');
    assert.equal(lines[14], '        digest: sha256:ddd');
    assert.equal(lines[20], '      version: 9.9.9');
  });

  test('a held version goes out once the platform catches up', async () => {
    const { bumpText } = await import('../../../packages/graft-sdk/cli/bump.mjs');
    const report = await bumpText(values, { platform: '2.70.0', listing, revoked: new Set() });
    const forum = report.changes.find((c: { id: string }) => c.id === 'forum');
    assert.deepEqual(forum, { id: 'forum', from: '1.1.0', to: '1.2.0', digest: 'sha256:120' });
    assert.ok(report.text.includes(`        version: '1.2.0' # {"$graftpolicy": "^1"}`));
    assert.ok(report.text.includes('        digest: "sha256:120"'));
    assert.equal(report.held.length, 0);
  });

  test('never downgrades and rejects a malformed marker', async () => {
    const { bumpText } = await import('../../../packages/graft-sdk/cli/bump.mjs');
    const ahead = values.replace(
      'version: 1.0.0 # {"$graftpolicy": "^1"}',
      'version: 1.9.0 # {"$graftpolicy": "^1"}'
    );
    const report = await bumpText(ahead, { platform: '2.69.0', listing, revoked: new Set() });
    assert.equal(
      report.changes.some((c: { id: string }) => c.id === 'greenhouse'),
      false
    );
    await assert.rejects(
      bumpText('grafts:\n  - id: x\n    version: 1.0.0 # {"$graftpolicy": }\n', {
        platform: '2.69.0',
        listing,
        revoked: new Set()
      }),
      /not valid JSON/
    );
  });
});

describe('mcp', () => {
  test('graft MCP tools register inside their namespace or claims only', async () => {
    const { loadMcpGrafts, registerGraftMcpTools } = await import('../src/grafts/mcp');
    const root = tmp('graft-mcp');
    const mcp = `module.exports = { register(server, client, ctx) {
      server.registerTool('notes_list', {}, () => ctx.apiBase);
      server.registerTool('list_sandboxes', {}, () => 1);
      server.registerTool('delete_everything', {}, () => 1);
    } };`;
    writeGraft(
      root,
      'notes',
      { 'mcp/index.js': mcp },
      baseManifest('notes', {
        entries: { mcp: 'mcp/index.js' },
        capabilities: ['mcp'],
        claims: { mcpTools: ['list_sandboxes'] }
      })
    );
    writeGraft(
      root,
      'nocap',
      { 'mcp/index.js': mcp },
      baseManifest('nocap', { entries: { mcp: 'mcp/index.js' } })
    );
    const prev = { dir: process.env.ORCHARD_GRAFTS_DIR, dev: process.env.ORCHARD_GRAFTS_DEV };
    process.env.ORCHARD_GRAFTS_DIR = root;
    process.env.ORCHARD_GRAFTS_DEV = '1';
    try {
      await loadMcpGrafts();
      const registered: string[] = [];
      const server = {
        registerTool: (name: string) => {
          registered.push(name);
        },
        name: 'fake'
      };
      registerGraftMcpTools(server, {});
      assert.deepEqual(registered, ['notes_list', 'list_sandboxes']);
    } finally {
      process.env.ORCHARD_GRAFTS_DIR = prev.dir;
      process.env.ORCHARD_GRAFTS_DEV = prev.dev;
      if (prev.dir === undefined) delete process.env.ORCHARD_GRAFTS_DIR;
      if (prev.dev === undefined) delete process.env.ORCHARD_GRAFTS_DEV;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('database connection budget', () => {
  const record = (id: string, extra: Record<string, unknown> = {}) =>
    ({
      id,
      dir: '/tmp',
      status: 'loaded',
      warnings: [],
      manifest: { capabilities: ['db'], database: { coreReads: {}, ...extra } }
    }) as never;

  test('values beat the graft, the graft beats the default', async () => {
    const { graftPoolSize } = await import('../src/grafts/db-budget');
    assert.deepEqual(graftPoolSize(record('a'), {}), { size: 3, source: 'default' });
    assert.deepEqual(graftPoolSize(record('a', { pool: 10 }), {}), { size: 10, source: 'graft' });
    assert.deepEqual(
      graftPoolSize(record('a', { pool: 10 }), { ORCHARD_GRAFT_POOLS: '{"a":15}' }),
      { size: 15, source: 'values' }
    );
    assert.deepEqual(graftPoolSize(record('a'), { ORCHARD_GRAFT_POOLS: 'not json' }), {
      size: 3,
      source: 'default'
    });
  });

  test('peak counts every pod, and an update doubles the server pods', async () => {
    const { planDbBudget } = await import('../src/grafts/db-budget');
    const budget = planDbBudget(
      { maxConnections: 100, reserved: 3, inUse: 20 },
      [record('greenhouse', { pool: 10 }), record('notes')],
      { ORCHARD_DB_SERVER_PODS: '2', ORCHARD_DB_WORKER_PODS: '1', DATABASE_CONNECTION_LIMIT: '10' }
    );
    assert.equal(budget.perPod, 23);
    assert.equal(budget.steadyPeak, 69);
    assert.equal(budget.rolloutPeak, 115);
    assert.equal(budget.usable, 97);
    assert.equal(budget.level, 'over');
  });

  test('behind the pooler, core queries cost a fixed share however many pods run', async () => {
    const { planDbBudget } = await import('../src/grafts/db-budget');
    const budget = planDbBudget(
      { maxConnections: 100, reserved: 3, inUse: 20 },
      [record('greenhouse', { pool: 10 }), record('notes')],
      {
        ORCHARD_DB_SERVER_PODS: '2',
        ORCHARD_DB_WORKER_PODS: '1',
        DATABASE_CONNECTION_LIMIT: '10',
        ORCHARD_DB_POOLER_CONNECTIONS: '40'
      }
    );
    assert.equal(budget.corePerPod, 0);
    assert.equal(budget.perPod, 13);
    assert.equal(budget.steadyPeak, 79);
    assert.equal(budget.rolloutPeak, 105);
  });

  test('the core client goes through the pooler while DATABASE_URL stays direct', async () => {
    const { buildDatasourceUrl } = await import('../src/prisma/prisma.service');
    const direct = 'postgresql://orchard:pw@orchard-db-rw.orchard:5432/orchard';
    const pooled = new URL(
      buildDatasourceUrl({
        DATABASE_URL: direct,
        DATABASE_POOLER_HOST: 'orchard-db-pooler-rw.orchard.svc.cluster.local'
      })!
    );
    assert.equal(pooled.hostname, 'orchard-db-pooler-rw.orchard.svc.cluster.local');
    assert.equal(pooled.port, '5432');
    assert.equal(pooled.username, 'orchard');
    assert.equal(pooled.password, 'pw');
    assert.equal(pooled.pathname, '/orchard');
    assert.equal(pooled.searchParams.get('pgbouncer'), 'true');
    assert.equal(pooled.searchParams.get('connection_limit'), '10');
    const plain = new URL(buildDatasourceUrl({ DATABASE_URL: direct })!);
    assert.equal(plain.hostname, 'orchard-db-rw.orchard');
    assert.equal(plain.searchParams.has('pgbouncer'), false);
  });

  test('grafts without the db capability open no pool', async () => {
    const { planDbBudget } = await import('../src/grafts/db-budget');
    const noDb = {
      id: 'ui-only',
      dir: '/tmp',
      status: 'loaded',
      warnings: [],
      manifest: { capabilities: [], database: { coreReads: {} } }
    } as never;
    const budget = planDbBudget({ maxConnections: 200, reserved: 3, inUse: 0 }, [noDb], {});
    assert.equal(budget.grafts.length, 0);
    assert.equal(budget.level, 'ok');
  });
});
