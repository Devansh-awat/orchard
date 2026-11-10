import test from 'node:test';
import assert from 'node:assert/strict';
import { LeaseElector } from '../src/engine/core/lease-elector';

function fakeApi() {
  let lease: any = null;
  let rv = 0;
  const calls = { read: 0, create: 0, replace: 0 };
  const api = {
    calls,
    steal(holder: string) {
      lease = {
        ...lease,
        metadata: { ...lease.metadata, resourceVersion: String(++rv) },
        spec: { ...lease.spec, holderIdentity: holder, renewTime: new Date() }
      };
    },
    async readNamespacedLease() {
      calls.read += 1;
      if (!lease) throw Object.assign(new Error('nf'), { response: { statusCode: 404 } });
      return { body: structuredClone(lease) };
    },
    async createNamespacedLease(_ns: string, body: any) {
      calls.create += 1;
      lease = { ...body, metadata: { ...body.metadata, resourceVersion: String(++rv) } };
      return { body: structuredClone(lease) };
    },
    async replaceNamespacedLease(_n: string, _ns: string, body: any) {
      calls.replace += 1;
      if (body.metadata.resourceVersion !== lease.metadata.resourceVersion) {
        throw Object.assign(new Error('conflict'), { response: { statusCode: 409 } });
      }
      lease = { ...body, metadata: { ...body.metadata, resourceVersion: String(++rv) } };
      return { body: structuredClone(lease) };
    }
  };
  return api;
}

const quiet = { log() {}, warn() {}, error() {}, debug() {} } as any;

function elector(api: ReturnType<typeof fakeApi>) {
  return new LeaseElector({ makeApiClient: () => api } as any, {
    namespace: 'ns',
    name: 'l',
    identity: 'me',
    renewIntervalMs: 10,
    logger: quiet
  });
}

const wait = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

test('a holder renews with one write and no read', async () => {
  const api = fakeApi();
  const e = elector(api);
  e.start();
  await wait(5);
  assert.equal(e.isHolder(), true);
  const reads = api.calls.read;
  await wait(55);
  assert.equal(api.calls.read, reads);
  assert.ok(api.calls.replace >= 3);
  await e.stop();
});

test('a holder whose lease was taken loses it', async () => {
  const api = fakeApi();
  const e = elector(api);
  let lost = false;
  e.on('lost', () => {
    lost = true;
  });
  e.start();
  await wait(5);
  assert.equal(e.isHolder(), true);
  api.steal('other');
  await wait(30);
  assert.equal(lost, true);
  assert.equal(e.isHolder(), false);
  await e.stop();
});
