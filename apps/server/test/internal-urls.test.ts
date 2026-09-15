import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentsService } from '../src/projects/deployments.service';

// addInternalUrlsToServices never touches `this`, so it can be exercised
// without standing up the service's very large constructor.
const addInternalUrls = (services: any[], namespace: string) =>
  (DeploymentsService.prototype as any).addInternalUrlsToServices.call(null, services, namespace);

test('every port carries its own in-cluster address', () => {
  const [svc] = addInternalUrls(
    [
      {
        name: 'web',
        port: 80,
        ports: [
          { id: 'p1', port: 80, targetPort: 80, protocol: 'TCP' },
          { id: 'p2', port: 8443, targetPort: 8443, protocol: 'TCP' }
        ]
      }
    ],
    'proj-abc'
  );

  assert.equal(svc.ports[0].internalUrl, 'web.proj-abc.svc.cluster.local:80');
  assert.equal(svc.ports[1].internalUrl, 'web.proj-abc.svc.cluster.local:8443');
  assert.equal(svc.internalHost, 'web.proj-abc.svc.cluster.local');
});

test('the address uses the service port, not the container port', () => {
  // In-cluster traffic reaches the Service, which is what forwards on to
  // targetPort. Advertising targetPort would hand out an unroutable address.
  const [svc] = addInternalUrls(
    [{ name: 'api', port: 80, ports: [{ id: 'p1', port: 80, targetPort: 3000, protocol: 'TCP' }] }],
    'ns1'
  );
  assert.equal(svc.ports[0].internalUrl, 'api.ns1.svc.cluster.local:80');
});

test('a service with no ports array still gets an address', () => {
  const [svc] = addInternalUrls([{ name: 'legacy', port: 8080 }], 'ns2');
  assert.equal(svc.internalUrl, 'legacy.ns2.svc.cluster.local:8080');
  assert.deepEqual(svc.internalUrls, ['legacy.ns2.svc.cluster.local:8080']);
});

test('existing port fields survive the rewrite', () => {
  const [svc] = addInternalUrls(
    [
      {
        name: 'web',
        port: 80,
        ports: [{ id: 'p1', port: 80, targetPort: 80, protocol: 'UDP', publicPort: 30001 }]
      }
    ],
    'ns3'
  );
  assert.equal(svc.ports[0].protocol, 'UDP');
  assert.equal(svc.ports[0].publicPort, 30001);
  assert.equal(svc.ports[0].id, 'p1');
});

test('a missing namespace leaves the services untouched', () => {
  const input = [{ name: 'web', port: 80, ports: [{ port: 80 }] }];
  assert.equal(addInternalUrls(input, ''), input);
});
