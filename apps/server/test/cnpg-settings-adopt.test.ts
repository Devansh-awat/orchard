import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLIED_SHARED_BUFFERS_ANNOTATION,
  planCompressionAdoption,
  planParameterAdoption,
  sharedBuffersStamp
} from '../src/kubernetes/cnpg-spec-sync';

const cluster = (opts: {
  parameters?: Record<string, string>;
  stamp?: string;
  memory?: string;
  compression?: 'gzip' | null;
  backup?: boolean;
}) => ({
  metadata: {
    annotations: opts.stamp ? { [APPLIED_SHARED_BUFFERS_ANNOTATION]: opts.stamp } : {}
  },
  spec: {
    resources: { limits: { memory: opts.memory ?? '1Gi' } },
    postgresql: { parameters: { max_connections: '100', ...(opts.parameters ?? {}) } },
    ...(opts.backup === false
      ? {}
      : {
          backup: {
            barmanObjectStore: opts.compression ? { data: { compression: opts.compression } } : {}
          }
        })
  }
});

test('a setting changed with kubectl becomes the stored setting', () => {
  const plan = planParameterAdoption(cluster({ parameters: { work_mem: '16MB' } }), {});
  assert.deepEqual(plan?.changed, ['work_mem']);
  assert.equal(plan?.parameters.work_mem, '16MB');
});

test('orchard defaults are not mistaken for user settings', () => {
  assert.equal(planParameterAdoption(cluster({}), {}), null);
});

test('a setting removed with kubectl is removed from the row', () => {
  const plan = planParameterAdoption(cluster({}), { statement_timeout: '30000' });
  assert.deepEqual(plan?.changed, ['statement_timeout']);
  assert.equal('statement_timeout' in (plan?.parameters ?? {}), false);
});

test('out-of-range values are refused, never stored', () => {
  const plan = planParameterAdoption(cluster({ parameters: { max_connections: '9000' } }), {});
  assert.deepEqual(plan?.changed, []);
  assert.deepEqual(plan?.refused, ['max_connections']);
});

test('shared_buffers orchard wrote itself is never adopted, even when stale', () => {
  const stale = cluster({ parameters: { shared_buffers: '64MB' }, stamp: '64MB' });
  assert.equal(planParameterAdoption(stale, {}), null);
  const unstamped = cluster({ parameters: { shared_buffers: '200MB' } });
  assert.equal(planParameterAdoption(unstamped, {}), null);
});

test('shared_buffers edited by hand is adopted up to 40% of memory, refused above', () => {
  const edited = planParameterAdoption(
    cluster({ parameters: { shared_buffers: '384MB' }, stamp: '256MB', memory: '1Gi' }),
    {}
  );
  assert.equal(edited?.parameters.shared_buffers, '384MB');
  const unsafe = planParameterAdoption(
    cluster({ parameters: { shared_buffers: '900MB' }, stamp: '256MB', memory: '1Gi' }),
    {}
  );
  assert.deepEqual(unsafe?.refused, ['shared_buffers']);
  assert.equal(unsafe?.parameters.shared_buffers, undefined);
});

test('the reconcile stamps clusters that predate the annotation, once', () => {
  const old = { spec: { postgresql: { parameters: { shared_buffers: '256MB' } } } };
  assert.deepEqual(sharedBuffersStamp(old, null), {
    [APPLIED_SHARED_BUFFERS_ANNOTATION]: '256MB'
  });
  const stamped = {
    ...old,
    metadata: { annotations: { [APPLIED_SHARED_BUFFERS_ANNOTATION]: 'x' } }
  };
  assert.equal(sharedBuffersStamp(stamped, null), undefined);
  assert.deepEqual(
    sharedBuffersStamp(stamped, { postgresql: { parameters: { shared_buffers: '128MB' } } }),
    { [APPLIED_SHARED_BUFFERS_ANNOTATION]: '128MB' }
  );
});

test('compression edited in k8s is adopted, but never gzip where it can OOM', () => {
  assert.equal(
    planCompressionAdoption(cluster({ memory: '1Gi', compression: 'gzip' }), null),
    null
  );
  assert.equal(
    planCompressionAdoption(cluster({ memory: '1Gi', compression: null }), null),
    'none'
  );
  assert.equal(
    planCompressionAdoption(cluster({ memory: '1Gi', compression: 'gzip' }), 'none'),
    'gzip'
  );
  assert.equal(
    planCompressionAdoption(cluster({ memory: '256Mi', compression: 'gzip' }), null),
    null
  );
  assert.equal(planCompressionAdoption(cluster({ backup: false }), null), null);
});

test('clearing a setting in orchard removes it from the cluster too', async () => {
  const { DatabasesService } = await import('../src/projects/databases.service');
  const { PG_PARAM_BOUNDS } = await import('../src/kubernetes/pg-params');
  const patches: Record<string, string | null>[] = [];
  const service = Object.create(DatabasesService.prototype) as any;
  service.PG_PARAM_BOUNDS = PG_PARAM_BOUNDS;
  service.access = {
    assertDatabaseEditor: async () => ({
      database: {
        id: 'd1',
        mode: 'cnpg',
        namespace: 'acme',
        clusterName: 'pg-db',
        projectId: 'p1',
        cpuRequestMilli: null,
        memoryRequestBytes: null,
        backupCompression: null,
        sharedPreloadLibs: [],
        pgParameters: { work_mem: '16MB', statement_timeout: '30000' }
      }
    })
  };
  service.quotasService = { resolvePodResources: async () => ({ memoryBytes: 1024 ** 3 }) };
  service.k8sCnpg = {
    updateCnpgParameters: async (_ns: string, _name: string, params: any) => patches.push(params)
  };
  service.prisma = { database: { update: async () => ({}) } };

  await service.updateDatabaseSettings('d1', { parameters: { work_mem: '32MB' } }, 'clerk');
  assert.equal(patches[0].work_mem, '32MB');
  assert.equal(patches[0].statement_timeout, null);
  assert.ok(patches[0].shared_buffers);
});

test('every stored setting vanishing at once is held, not adopted as removals', () => {
  const plan = planParameterAdoption(cluster({}), { work_mem: '16MB', statement_timeout: '30000' });
  assert.deepEqual(plan?.changed, []);
  assert.deepEqual(plan?.refused.sort(), ['statement_timeout', 'work_mem']);
});
