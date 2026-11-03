import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoUrlChoice, autoUrlProtection } from '../src/projects/auto-url';

const row = (port: number, reach?: string) => ({ containerPort: port, servicePort: port, reach });
const service = (...ports: number[]) => ({
  port: ports[0],
  ports: ports.map((port) => ({ port }))
});

test('callers that say nothing about reach stay protected', () => {
  assert.deepEqual(autoUrlChoice(undefined), {});
  assert.deepEqual(autoUrlChoice([row(3000)]), {});
  assert.equal(autoUrlProtection(autoUrlChoice([row(3000)]), [service(3000)]), 'orchard');
});

test('a private link stays protected', () => {
  const choice = autoUrlChoice([row(3000, 'link')]);
  assert.deepEqual(choice, { servicePort: 3000, isPublic: false });
  assert.equal(autoUrlProtection(choice, [service(3000)]), 'orchard');
});

test('a public link is open, and only on the port that asked for it', () => {
  const choice = autoUrlChoice([row(5432, 'internal'), row(3000, 'public-link')]);
  assert.deepEqual(choice, { servicePort: 3000, isPublic: true });
  assert.equal(autoUrlProtection(choice, [service(5432, 3000)]), 'none');
});

test('the first linked port decides, so a private port is never opened by a later public one', () => {
  const choice = autoUrlChoice([row(3000, 'link'), row(4000, 'public-link')]);
  assert.deepEqual(choice, { servicePort: 3000, isPublic: false });
  assert.equal(autoUrlProtection(choice, [service(3000, 4000)]), 'orchard');
});

test('a public choice for a port the service does not have stays protected', () => {
  const choice = autoUrlChoice([row(3000, 'public-link')]);
  assert.equal(autoUrlProtection(choice, [service(8080)]), 'orchard');
  assert.equal(autoUrlProtection(choice, []), 'orchard');
});

test('unknown reach values are not public', () => {
  assert.deepEqual(autoUrlChoice([row(3000, 'port'), row(4000, 'internal')]), {});
  assert.deepEqual(autoUrlChoice([{ reach: 'public', containerPort: 3000 }]), {});
});
