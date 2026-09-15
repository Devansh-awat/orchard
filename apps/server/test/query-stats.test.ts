import test from 'node:test';
import assert from 'node:assert/strict';
import { K8sCnpgService } from '../src/kubernetes/k8s-cnpg.service';

test('query stats request machine-readable psql output', async () => {
  const service = Object.create(K8sCnpgService.prototype) as any;
  let command: string[] = [];
  service.findCnpgPrimaryPod = async () => 'database-1';
  service.execInPod = async (
    _namespace: string,
    _pod: string,
    _container: string,
    args: string[]
  ) => {
    command = args;
    return {
      stdout: '[{"id":"42","query":"select $1","calls":3}]\n',
      stderr: '',
      success: true
    };
  };

  const result = await service.getQueryStats('tenant', 'database', 'app');

  assert.deepEqual(command.slice(0, 9), [
    'psql',
    '-U',
    'postgres',
    '-d',
    'app',
    '-v',
    'ON_ERROR_STOP=1',
    '-t',
    '-A'
  ]);
  assert.equal(command[9], '-c');
  assert.deepEqual(result, {
    installed: true,
    queries: [{ id: '42', query: 'select $1', calls: 3 }]
  });
});
