import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { StorageService } from '../src/organizations/storage.service';
import { setObjectStorageOverride } from '../src/instance-config/object-storage';
import { assertUploadUrlOwned } from '../src/organizations/upload-namespace';

const NAMES = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
  'R2_ENDPOINT',
  'LOCAL_STORE_ENDPOINT',
  'LOCAL_STORE_UPLOADS_BUCKET'
];

const BASE = 'https://assets.example.com';

async function withStorage(fn: () => Promise<void> | void) {
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    R2_BUCKET_NAME: 'prod-assets',
    R2_PUBLIC_URL: BASE
  });
  setObjectStorageOverride({});
  try {
    await fn();
  } finally {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function storageWithRecorder() {
  const sent: any[] = [];
  const svc: any = new StorageService();
  svc.uploads = () => ({
    client: {
      send: async (cmd: any) => {
        sent.push(cmd.input);
      }
    },
    target: { bucket: 'prod-assets', keyPrefix: '', publicUrl: BASE }
  });
  return { svc: svc as StorageService, sent };
}

test('deleteFile removes a file inside the caller namespace', () =>
  withStorage(async () => {
    const { svc, sent } = storageWithRecorder();
    await svc.deleteFile(`${BASE}/project-icons/p1/abc.png`, 'project-icons/p1');
    assert.deepEqual(sent, [{ Bucket: 'prod-assets', Key: 'project-icons/p1/abc.png' }]);
  }));

test("deleteFile refuses another tenant's file", () =>
  withStorage(async () => {
    const { svc, sent } = storageWithRecorder();
    await svc.deleteFile(`${BASE}/users/victim/avatar.png`, 'project-icons/p1');
    await svc.deleteFile(`${BASE}/organizations/o2/a.png`, 'organizations/o1');
    await svc.deleteFile(`${BASE}/project-icons/p10/a.png`, 'project-icons/p1');
    assert.equal(sent.length, 0);
  }));

test('deleteFile refuses legacy un-namespaced keys and traversal', () =>
  withStorage(async () => {
    const { svc, sent } = storageWithRecorder();
    await svc.deleteFile(`${BASE}/project-icons/legacy.png`, 'project-icons/p1');
    await svc.deleteFile(`${BASE}/project-icons/p1/../../users/victim/a.png`, 'project-icons/p1');
    await svc.deleteFile(`${BASE}/project-icons/p1/%2e%2e/x.png`, 'project-icons/p1');
    await svc.deleteFile('https://evil.example.com/project-icons/p1/a.png', 'project-icons/p1');
    assert.equal(sent.length, 0);
  }));

test('stored URL fields cannot point into another namespace', () =>
  withStorage(() => {
    const foreign = `${BASE}/users/victim/avatar.png`;
    assert.throws(
      () => assertUploadUrlOwned(foreign, 'project-icons/p1', null, 'Icon'),
      BadRequestException
    );
    assert.throws(() => assertUploadUrlOwned(foreign, null, null, 'Icon'), BadRequestException);
    assertUploadUrlOwned(`${BASE}/project-icons/p1/a.png`, 'project-icons/p1', null, 'Icon');
    assertUploadUrlOwned(foreign, 'project-icons/p1', foreign, 'Icon');
    assertUploadUrlOwned('https://example.org/x.png', 'project-icons/p1', null, 'Icon');
    assertUploadUrlOwned('rocket', 'project-icons/p1', null, 'Icon');
    assertUploadUrlOwned(null, 'project-icons/p1', null, 'Icon');
  }));

type Row = Record<string, unknown> & { id: string };

function fakeDb(rows: Partial<Record<string, Row[]>>) {
  const table = (model: string) => ({
    count: async ({ where }: any) => {
      const column = Object.keys(where).find((k) => k !== 'NOT')!;
      const needle = where[column].contains as string;
      const excluded = where.NOT ? Object.values(where.NOT)[0] : null;
      return (rows[model] ?? []).filter(
        (r) =>
          typeof r[column] === 'string' &&
          (r[column] as string).includes(needle) &&
          (excluded === null || (r.id ?? r.organizationId) !== excluded)
      ).length;
    }
  });
  const db: any = {};
  for (const model of [
    'user',
    'organization',
    'project',
    'identityProvider',
    'orgSsoSettings',
    'template'
  ]) {
    db[model] = table(model);
  }
  return db;
}

function storageWithDb(db: any, failWith?: string) {
  const sent: any[] = [];
  const svc: any = new StorageService(db);
  svc.uploads = () => ({
    client: {
      send: async (cmd: any) => {
        sent.push(cmd.input);
        if (failWith) throw Object.assign(new Error(failWith), { name: failWith });
      }
    },
    target: { bucket: 'prod-assets', keyPrefix: '', publicUrl: BASE }
  });
  return { svc: svc as StorageService, sent };
}

const iconOwner = { model: 'project' as const, id: 'p1', column: 'icon' };

test('deleteReplaced removes a legacy object only its own record referenced', () =>
  withStorage(async () => {
    const url = `${BASE}/project-icons/legacy.png`;
    const { svc, sent } = storageWithDb(fakeDb({ project: [{ id: 'p1', icon: url }] }));
    await svc.deleteReplaced(url, 'project-icons/p1', iconOwner);
    assert.deepEqual(sent, [{ Bucket: 'prod-assets', Key: 'project-icons/legacy.png' }]);
  }));

test('deleteReplaced keeps a legacy object another record still references', () =>
  withStorage(async () => {
    const url = `${BASE}/project-icons/legacy.png`;
    const { svc, sent } = storageWithDb(
      fakeDb({
        project: [
          { id: 'p1', icon: url },
          { id: 'p2', icon: url }
        ]
      })
    );
    await svc.deleteReplaced(url, 'project-icons/p1', iconOwner);
    assert.equal(sent.length, 0);
  }));

test('deleteReplaced keeps a victim file whose URL was planted in another tenant record', () =>
  withStorage(async () => {
    const victim = `${BASE}/users/legacy-victim.png`;
    const { svc, sent } = storageWithDb(
      fakeDb({
        project: [{ id: 'attacker', icon: victim }],
        user: [{ id: 'victim', imageUrl: victim }]
      })
    );
    await svc.deleteReplaced(victim, 'project-icons/attacker', {
      model: 'project',
      id: 'attacker',
      column: 'icon'
    });
    assert.equal(sent.length, 0);
  }));

test('deleteReplaced sees a reference in a different column of the same record', () =>
  withStorage(async () => {
    const url = `${BASE}/project-icons/legacy.png`;
    const { svc, sent } = storageWithDb(
      fakeDb({ project: [{ id: 'p1', icon: url, backgroundImage: url }] })
    );
    await svc.deleteReplaced(url, 'project-icons/p1', iconOwner);
    assert.equal(sent.length, 0);
  }));

test('deleteReplaced deletes a namespaced object without consulting references', () =>
  withStorage(async () => {
    const { svc, sent } = storageWithDb(null);
    await svc.deleteReplaced(`${BASE}/project-icons/p1/abc.png`, 'project-icons/p1', iconOwner);
    assert.deepEqual(sent, [{ Bucket: 'prod-assets', Key: 'project-icons/p1/abc.png' }]);
  }));

test('deleteReplaced deletes a Gravatar object only its user referenced', () =>
  withStorage(async () => {
    const url = `${BASE}/users/email-avatar/abc-k1.png`;
    const owner = { model: 'user' as const, id: 'u1', column: 'imageUrl' };
    const own = storageWithDb(fakeDb({ user: [{ id: 'u1', imageUrl: url }] }));
    await own.svc.deleteReplaced(url, 'users/u1', owner);
    assert.equal(own.sent.length, 1);
    const shared = storageWithDb(
      fakeDb({
        user: [
          { id: 'u1', imageUrl: url },
          { id: 'u2', imageUrl: url }
        ]
      })
    );
    await shared.svc.deleteReplaced(url, 'users/u1', owner);
    assert.equal(shared.sent.length, 0);
  }));

test('deleteReplaced never deletes another tenant namespace or traversal keys', () =>
  withStorage(async () => {
    const { svc, sent } = storageWithDb(fakeDb({}));
    await svc.deleteReplaced(`${BASE}/users/victim/avatar.png`, 'project-icons/p1', iconOwner);
    await svc.deleteReplaced(`${BASE}/project-icons/../users/a.png`, 'project-icons/p1', iconOwner);
    await svc.deleteReplaced(`${BASE}/builds/x.png`, 'project-icons/p1', iconOwner);
    assert.equal(sent.length, 0);
  }));

test('deleteReplaced tolerates an object that is already gone', () =>
  withStorage(async () => {
    const url = `${BASE}/project-icons/legacy.png`;
    const { svc, sent } = storageWithDb(fakeDb({}), 'NoSuchKey');
    await svc.deleteReplaced(url, 'project-icons/p1', iconOwner);
    assert.equal(sent.length, 1);
  }));
