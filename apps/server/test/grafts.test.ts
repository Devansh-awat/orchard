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
import { Client } from 'pg';
import { satisfies } from '../src/grafts/semver';
import { resolveClaims, canUseName } from '../src/grafts/claims';
import { verifyGraftDir, listFiles, sha256File } from '../src/grafts/integrity';
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
    const signed = writeGraft(
      root,
      'signed',
      { 'server/index.js': 'module.exports={}' },
      baseManifest('signed')
    );
    seal(signed, privateKey);
    assert.equal(verifyGraftDir(signed, 'signed', [key]).signedBy, 'publisher');
    assert.throws(() => verifyGraftDir(signed, 'official', [key]), /official/);
    assert.throws(() => verifyGraftDir(signed, 'signed', []), /does not verify/);

    const unsigned = writeGraft(root, 'unsigned', { 'a.txt': 'x' }, baseManifest('unsigned'));
    seal(unsigned);
    assert.throws(() => verifyGraftDir(unsigned, 'signed', [key]), /unsigned/);
    assert.equal(verifyGraftDir(unsigned, 'any', []).signedBy, null);

    writeFileSync(join(signed, 'server/index.js'), 'module.exports={evil:true}');
    assert.throws(() => verifyGraftDir(signed, 'signed', [key]), /does not match/);
    writeFileSync(join(unsigned, 'extra.js'), '');
    assert.throws(() => verifyGraftDir(unsigned, 'any', []), /not covered/);
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
        ORCHARD_GRAFT_TRUST: 'any'
      }) as NodeJS.ProcessEnv;

    const ok = await syncGrafts(
      env([{ id: 'notes', version: '1.0.0', source: `file://${artifactPath}`, digest }])
    );
    assert.deepEqual(ok, { synced: ['notes'], failed: [] });
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
              useValue: { log: async (input: { action: string }) => void logged.push(input) }
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
      const server = { registerTool: (name: string) => void registered.push(name), name: 'fake' };
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
