import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY, firstValueFrom, toArray } from 'rxjs';
import { ObservabilityService } from '../src/observability/observability.service';

const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';

function service(rows: unknown[][], seen: { sql: string; values: unknown[] }[]) {
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push({ sql: strings.join('?'), values });
      return rows.shift() ?? [];
    }
  };
  const orgEvents = { forDeployment: () => EMPTY };
  return new (ObservabilityService as any)(prisma, {}, orgEvents, {}, {}, {}) as ObservabilityService;
}

test('casts the log offset to int, which is the only type substring takes', async () => {
  const seen: { sql: string; values: unknown[] }[] = [];
  const svc = service(
    [[{ chunk: 'more\n', total: 9, build_status: 'failed', build_step: 'build' }]],
    seen
  );

  const events = await firstValueFrom(svc.streamBuildLogs(DEPLOYMENT_ID, 4).pipe(toArray()));

  assert.match(seen[0].sql, /substring\(build_logs from \?::int\)/);
  assert.equal(seen[0].values[0], 5);
  assert.deepEqual(
    events.map((e) => e.data),
    [{ offset: 9, chunk: 'more\n' }, { done: true, status: 'failed', step: 'build' }]
  );
});

test('ends when the deployment row is gone', async () => {
  const seen: { sql: string; values: unknown[] }[] = [];
  const svc = service([[]], seen);

  const events = await firstValueFrom(svc.streamBuildLogs(DEPLOYMENT_ID, 0).pipe(toArray()));

  assert.deepEqual(
    events.map((e) => e.data),
    [{ done: true, status: 'deleted' }]
  );
});
