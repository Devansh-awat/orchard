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
    client: { send: async (cmd: any) => void sent.push(cmd.input) },
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
