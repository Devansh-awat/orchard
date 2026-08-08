import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as k8s from '@kubernetes/client-node';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';

// enableProtectionProxy decides whether a domain is behind the auth wall. It
// used to swallow every failure and return void, so a domain could be recorded
// as protected while the Ingress still pointed straight at the app. These
// exercise the three outcomes against a stubbed API server.

const PROXY = 'orchard-protection-proxy';

function ingressWithBackends(names: string[]) {
  return {
    body: {
      metadata: { name: 'app-ing', namespace: 'ns' },
      spec: {
        rules: [
          { http: { paths: names.map((n) => ({ path: '/', backend: { service: { name: n, port: { number: 80 } } } })) } },
        ],
      },
    },
  };
}

function notFound() {
  const e: any = new Error('HTTP request failed');
  e.name = 'HttpError';
  e.statusCode = 404;
  e.response = { statusCode: 404 };
  e.body = { message: 'ingresses.networking.k8s.io "app-ing" not found', reason: 'NotFound' };
  return e;
}

// Builds a service with just enough wiring for enableProtectionProxy to run.
// `onReplace` decides what the API server "persists" and hands back.
function buildService(opts: {
  readIngress: () => any;
  onReplace?: (body: any) => any;
}) {
  const svc = Object.create(K8sNetworkService.prototype) as any;
  svc.logger = { error() {}, warn() {}, log() {} };
  svc.prisma = {};
  // kc is a prototype getter that reads through to KubernetesService, so the
  // stub has to go there rather than on the instance.
  svc.kubernetes = { ensureKubeConfig() {}, kc: {
    makeApiClient(api: any) {
      if (api === k8s.CoreV1Api) {
        return {
          readNamespacedService: async () => ({ body: { spec: { clusterIP: '10.0.0.1' } } }),
          createNamespacedService: async () => ({}),
          replaceNamespacedService: async () => ({}),
        };
      }
      if (api === k8s.CustomObjectsApi) {
        return { createNamespacedCustomObject: async () => ({}), replaceNamespacedCustomObject: async () => ({}) };
      }
      return {
        readNamespacedIngress: async () => opts.readIngress(),
        replaceNamespacedIngress: async (_n: string, _ns: string, body: any) => (
          opts.onReplace ? opts.onReplace(body) : { body }
        ),
      };
    },
  } };
  svc.ensureOrchardIngressAllowed = async () => {};
  return svc as K8sNetworkService;
}

test('applied when every path ends up behind the proxy', async () => {
  const svc = buildService({ readIngress: () => ingressWithBackends(['app-svc']) });
  assert.equal(await svc.enableProtectionProxy('ns', 'app-ing'), 'applied');
});

test('ingress-missing when the row outlived its Ingress', async () => {
  const svc = buildService({ readIngress: () => { throw notFound(); } });
  assert.equal(await svc.enableProtectionProxy('ns', 'app-ing'), 'ingress-missing');
});

test('failed when the API server silently keeps the app backend', async () => {
  // A mutating webhook or a conflicting controller can hand back an object
  // that is not what we wrote. Previously this looked like success.
  const svc = buildService({
    readIngress: () => ingressWithBackends(['app-svc']),
    onReplace: () => ingressWithBackends(['app-svc']),
  });
  assert.equal(await svc.enableProtectionProxy('ns', 'app-ing'), 'failed');
});

test('failed when only some paths get repointed', async () => {
  const svc = buildService({
    readIngress: () => ingressWithBackends(['app-svc', 'api-svc']),
    onReplace: () => ingressWithBackends([PROXY, 'api-svc']),
  });
  assert.equal(await svc.enableProtectionProxy('ns', 'app-ing'), 'failed');
});

test('failed, not ingress-missing, when the read fails for another reason', async () => {
  const svc = buildService({
    readIngress: () => {
      const e: any = new Error('HTTP request failed');
      e.name = 'HttpError';
      e.statusCode = 500;
      e.response = { statusCode: 500 };
      return e && (() => { throw e; })();
    },
  });
  assert.equal(await svc.enableProtectionProxy('ns', 'app-ing'), 'failed');
});

test('every path is rewritten to the proxy before the write', async () => {
  let written: any;
  const svc = buildService({
    readIngress: () => ingressWithBackends(['app-svc', 'api-svc']),
    onReplace: (body) => { written = body; return { body }; },
  });
  await svc.enableProtectionProxy('ns', 'app-ing');
  const names = written.spec.rules.flatMap((r: any) => r.http.paths.map((p: any) => p.backend.service.name));
  assert.deepEqual(names, [PROXY, PROXY]);
});

test('failed when the ingress has no rule paths to repoint', async () => {
  const svc = buildService({
    readIngress: () => ({ body: { metadata: { name: 'app-ing', namespace: 'ns' }, spec: { defaultBackend: { service: { name: 'app-svc', port: { number: 80 } } } } } }),
  });
  assert.equal(await svc.enableProtectionProxy('ns', 'app-ing'), 'failed');
});

// ── restoreOrphanedProtectionBackends ──
//
// This is the one function that can take a domain OUT from behind the auth
// wall. It exists to undo the proxy after protection is switched off, but the
// same code path would strip a live protected domain if its guards ever
// loosened. Each of these pins one guard.

const PROXIED_INGRESS = {
  metadata: { name: 'app-ing', namespace: 'ns' },
  spec: {
    rules: [{ http: { paths: [{ path: '/', backend: { service: { name: PROXY, port: { number: 3001 } } } }] } }],
  },
};

function buildRestoreService(opts: { rows: any[]; proxyServiceExists: boolean }) {
  const svc = Object.create(K8sNetworkService.prototype) as any;
  const writes: any[] = [];
  svc.logger = { error() {}, warn() {}, log() {} };
  svc.prisma = { ingress: { findMany: async () => opts.rows } };
  svc.kubernetes = { ensureKubeConfig() {}, kc: {
    makeApiClient(api: any) {
      if (api === k8s.CoreV1Api) {
        return {
          readNamespacedService: async () => {
            if (opts.proxyServiceExists) return { body: {} };
            const e: any = new Error('not found');
            e.response = { statusCode: 404 };
            throw e;
          },
        };
      }
      return {
        listIngressForAllNamespaces: async () => ({
          body: { items: [JSON.parse(JSON.stringify(PROXIED_INGRESS))] },
        }),
        replaceNamespacedIngress: async (_n: string, _ns: string, body: any) => {
          writes.push(body); return { body };
        },
      };
    },
  } };
  return { svc: svc as any, writes };
}

const unprotectedRow = { protectionMode: 'none', path: '/', service: { name: 'app', port: 3000, ports: [{ port: 3000 }] } };

test('restore leaves a PROTECTED domain behind the proxy', async () => {
  const { svc, writes } = buildRestoreService({
    rows: [{ ...unprotectedRow, protectionMode: 'orchard' }],
    proxyServiceExists: false,
  });
  await svc.restoreOrphanedProtectionBackends(new Set<string>());
  assert.equal(writes.length, 0, 'a protected ingress must never be repointed at the app');
});

test('restore leaves a domain alone when no DB row explains it', async () => {
  // A deleted row must not be read as "unprotected". This is what makes
  // cascading ingress deletes safe.
  const { svc, writes } = buildRestoreService({ rows: [], proxyServiceExists: false });
  await svc.restoreOrphanedProtectionBackends(new Set<string>());
  assert.equal(writes.length, 0, 'a missing row must not strip the auth wall');
});

test('restore leaves a domain alone while the proxy service still exists', async () => {
  const { svc, writes } = buildRestoreService({ rows: [unprotectedRow], proxyServiceExists: true });
  await svc.restoreOrphanedProtectionBackends(new Set<string>());
  assert.equal(writes.length, 0);
});

test('restore skips anything still in the protected set', async () => {
  const { svc, writes } = buildRestoreService({ rows: [unprotectedRow], proxyServiceExists: false });
  await svc.restoreOrphanedProtectionBackends(new Set(['ns/app-ing']));
  assert.equal(writes.length, 0);
});

test('restore does repoint a genuinely unprotected, orphaned ingress', async () => {
  const { svc, writes } = buildRestoreService({ rows: [unprotectedRow], proxyServiceExists: false });
  await svc.restoreOrphanedProtectionBackends(new Set<string>());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].spec.rules[0].http.paths[0].backend.service.name, 'app');
});
