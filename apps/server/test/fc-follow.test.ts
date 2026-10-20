import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageBuilderService } from '../src/docker/image-builder.service';
import { ndjson, type FcEvent } from '../src/docker/fc/fc-client';

process.env.KUBECONFIG = '/nonexistent';

function harness() {
  const state = {
    logs: '',
    steps: [] as string[],
    timestamps: {} as Record<string, number>,
    detected: null as unknown,
    meta: ''
  };
  const prisma: any = {
    $executeRaw: (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('"build_logs"')) {
        const text = vals.find(
          (v) =>
            typeof v === 'string' &&
            v.length > 0 &&
            !/^[0-9a-f-]{36}$/.test(v) &&
            !v.startsWith('fc:')
        );
        if (typeof text === 'string') state.logs += text.endsWith('\n') ? text : `${text}\n`;
      }
      if (
        sql.includes(
          '"build_step_timestamps" = COALESCE("build_step_timestamps", \'{}\'::jsonb) ||'
        )
      ) {
        state.meta = String(vals[0]);
      }
      return Promise.resolve(1);
    },
    deployment: {
      findUnique: async () => ({
        buildStepTimestamps: { ...state.timestamps },
        projectId: 'p',
        project: { organizationId: 'o' }
      }),
      update: async ({ data }: any) => {
        if (data.buildStep) state.steps.push(data.buildStep);
        if (data.buildStepTimestamps) state.timestamps = data.buildStepTimestamps;
        if (data.detectedConfig) state.detected = data.detectedConfig;
        return {};
      }
    }
  };
  const ibs = new ImageBuilderService(prisma, { emit() {} } as any);
  return { ibs: ibs as any, state };
}

function stream(events: FcEvent[]) {
  const bytes = Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return {
    host: { id: 'fc-builder-0', url: 'http://fc-builder-0' },
    events: ndjson(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(bytes));
          c.close();
        }
      })
    )
  };
}

const vertex = (digest: string, name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    vertexes: [
      {
        digest,
        name,
        started: '2026-10-20T19:00:00.000Z',
        completed: '2026-10-20T19:00:01.000Z',
        ...extra
      }
    ]
  }) + '\n';

const base: FcEvent[] = [
  { t: 'accepted', at: 1, data: 'fc-builder-0', timings: { acquireMs: 1200, vmBootMs: 1200 } },
  { t: 'phase', at: 2, phase: 'ready' },
  { t: 'phase', at: 3, phase: 'source' },
  {
    t: 'log',
    at: 4,
    stream: 'source',
    data: '=== Fetching source ===\nRepository: https://github.com/x/y\n'
  },
  { t: 'phase', at: 5, phase: 'prepare' },
  {
    t: 'log',
    at: 6,
    stream: 'prepare',
    data: '=== Railpack prepare completed ===\n=== Build Info ===\n::orchard-railpack-info::{"detectedProviders":["node"],"metadata":{"nodeRuntime":"bun"}}\n'
  },
  { t: 'phase', at: 7, phase: 'build' }
];

test('a successful build stamps the phases, records the host and returns the pull ref', async () => {
  const { ibs, state } = harness();
  const image = await ibs.followFirecrackerBuild({
    deploymentId: '11111111-2222-3333-4444-555555555555',
    stream: stream([
      ...base,
      {
        t: 'log',
        at: 8,
        stream: 'build',
        data: vertex('sha256:aa', '[1/2] FROM docker.io/library/alpine')
      },
      { t: 'log', at: 9, stream: 'build', data: vertex('sha256:bb', 'exporting to image') },
      { t: 'result', at: 10, ok: true, timings: { buildMs: 9000 } }
    ]),
    buildId: 'dep-1-abcd',
    pullRef: 'harbor.example/orchard/app:v1',
    offset: 0,
    buildType: 'railpack',
    submittedAt: Date.now()
  });
  assert.equal(image, 'harbor.example/orchard/app:v1');
  assert.deepEqual(state.steps, ['building', 'pushing']);
  for (const key of ['submitted', 'scheduled', 'building', 'pushing']) {
    assert.ok(state.timestamps[key], `missing ${key}`);
  }
  const meta = JSON.parse(state.meta);
  assert.equal(meta.__builder, 'firecracker');
  assert.equal(meta.__fcHost, 'fc-builder-0');
  assert.equal(meta.__jobName, 'dep-1-abcd');
  assert.equal(meta.__image, 'harbor.example/orchard/app:v1');
  assert.match(state.logs, /Started a build VM in 1\.2s/);
  assert.match(state.logs, /=== Fetching source ===/);
  assert.match(state.logs, /=== Railpack ===/);
  assert.match(state.logs, /#[0-9a-f]{8} \[1\/2\] FROM/);
  assert.ok(state.detected, 'railpack detection not persisted');
});

test('a failed build throws a summary of the failing step', async () => {
  const { ibs } = harness();
  await assert.rejects(
    ibs.followFirecrackerBuild({
      deploymentId: '11111111-2222-3333-4444-555555555555',
      stream: stream([
        ...base,
        {
          t: 'log',
          at: 8,
          stream: 'build',
          data: vertex('sha256:cc', '[2/2] RUN bun run build', {
            error: 'process "/bin/sh -c bun run build" did not complete successfully: exit code: 1'
          })
        },
        { t: 'result', at: 9, ok: false, error: 'build step failed (exit 1)' }
      ]),
      buildId: 'dep-1-abcd',
      pullRef: 'harbor.example/orchard/app:v1',
      offset: 0,
      buildType: 'railpack',
      submittedAt: Date.now()
    }),
    (error: Error) => {
      assert.match(error.message, /^Build failed: /);
      assert.match(error.message, /bun run build|exit code: 1/);
      return true;
    }
  );
});

test('a cancelled build says so', async () => {
  const { ibs } = harness();
  await assert.rejects(
    ibs.followFirecrackerBuild({
      deploymentId: '11111111-2222-3333-4444-555555555555',
      stream: stream([...base, { t: 'result', at: 9, ok: false, error: 'build cancelled' }]),
      buildId: 'dep-1-abcd',
      pullRef: 'harbor.example/orchard/app:v1',
      offset: 0,
      buildType: 'dockerfile',
      submittedAt: Date.now()
    }),
    /Build failed: build cancelled/
  );
});
