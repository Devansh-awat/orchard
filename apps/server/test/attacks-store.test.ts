import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floodIps, maskReport, unrecordedReport } from '../src/security/attacks.service';
import { buildSuspicious, buildIpSeries } from '../src/logs/logsql';

test('floods need 300 requests, ten times the median and five clients', () => {
  const quiet = ['a', 'b', 'c', 'd'].map((ip) => ({ ip, requests: 10 }));
  assert.equal(floodIps([...quiet, { ip: 'x', requests: 5000 }]).get('x'), 5000);
  assert.equal(floodIps([...quiet.slice(0, 3), { ip: 'x', requests: 5000 }]).size, 0);
  assert.equal(floodIps([...quiet, { ip: 'x', requests: 250 }]).size, 0);
});

test('suspicious and per-ip queries stay scoped and quoted', () => {
  const scope = { namespace: 'ns', app: 'web', start: 0, end: 60_000 };
  const q = buildSuspicious(scope);
  assert.ok(
    q.startsWith(
      '(_stream:{namespace="ns",app="web",kind="access"} or _stream:{kind="access",ingress_service=~"^ns-web(--green)?-[^-]+$"})'
    )
  );
  assert.match(q, /status:>=400 or path:~"/);
  assert.match(buildIpSeries(scope, ['1.2.3.4"x'], 60_000), /client_ip:in\("1\.2\.3\.4\\"x"\)/);
});

test('an app without access logs reports that nothing was recorded, not zero attacks', () => {
  const report = unrecordedReport();
  assert.equal(report.recorded, false);
  assert.deepEqual(report.byKind, { scanner: 0, injection: 0, 'auth-bruteforce': 0, flood: 0 });
  assert.equal(maskReport(report).recorded, false);
});
