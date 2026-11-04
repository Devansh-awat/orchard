import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  chooseDefaultPort,
  createRegistryNet,
  exposedPortsFrom,
  finalBaseImage,
  inspectImagePorts,
  isRoutableRegistryAddress,
  parseImageRef,
  plainHttpHostsFrom,
  type RegistryNet
} from '../src/projects/image-ports';
import { ImagePortsController } from '../src/projects/image-ports.controller';
import { RegistryCredentialsService } from '../src/projects/registry-credentials.service';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const NONE = { port: null, ports: [] };
const SECRET = { username: 'alice', password: 's3cret' };
const SECRET_BASIC = `Basic ${Buffer.from('alice:s3cret').toString('base64')}`;

type Handler = (url: URL, headers: Record<string, string>) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), init);
}

function redirect(location: string, status = 307) {
  return new Response(null, { status, headers: { location } });
}

function challenge(realm: string, service = 'registry') {
  return new Response(null, {
    status: 401,
    headers: { 'www-authenticate': `Bearer realm="${realm}",service="${service}"` }
  });
}

function imageManifest(digest = 'sha256:cfg') {
  return json({ mediaType: MANIFEST, config: { digest } });
}

function imageConfig(...ports: string[]) {
  return json({
    architecture: 'amd64',
    config: { ExposedPorts: Object.fromEntries(ports.map((p) => [p, {}])) }
  });
}

function fakeNet(routes: Record<string, Handler>, dns: Record<string, string[]> = {}) {
  const calls: { url: string; host: string; authorization?: string; pinned: boolean }[] = [];
  const resolved: string[] = [];
  const net: RegistryNet = {
    resolve: async (hostname) => {
      resolved.push(hostname);
      return dns[hostname] ?? ['93.184.216.34'];
    },
    fetch: async (url, request) => {
      calls.push({
        url: url.href,
        host: url.host,
        authorization: request.headers.authorization,
        pinned: request.pinned
      });
      const handler = routes[`${url.origin}${url.pathname}`];
      if (!handler) return new Response(null, { status: 404 });
      return handler(url, request.headers);
    }
  };
  return { net, calls, resolved };
}

function inspect(image: string, net: RegistryNet, extra: Record<string, unknown> = {}) {
  const failures: string[] = [];
  return inspectImagePorts(image, {
    net,
    plainHttpHosts: new Set(),
    platform: 'linux/amd64',
    onFailure: (reason) => failures.push(reason),
    ...extra
  }).then((result) => ({ result, failures }));
}

test('image references normalise the way docker reads them', () => {
  assert.deepEqual(parseImageRef('nginx'), {
    registry: 'docker.io',
    repository: 'library/nginx',
    reference: 'latest'
  });
  assert.deepEqual(parseImageRef('nginx:1.27'), {
    registry: 'docker.io',
    repository: 'library/nginx',
    reference: '1.27'
  });
  assert.deepEqual(parseImageRef('docker.io/nginx'), {
    registry: 'docker.io',
    repository: 'library/nginx',
    reference: 'latest'
  });
  assert.deepEqual(parseImageRef('index.docker.io/stefanprodan/podinfo:6'), {
    registry: 'docker.io',
    repository: 'stefanprodan/podinfo',
    reference: '6'
  });
  assert.deepEqual(parseImageRef('ghcr.io/stefanprodan/podinfo:6@sha256:abc'), {
    registry: 'ghcr.io',
    repository: 'stefanprodan/podinfo',
    reference: 'sha256:abc'
  });
  assert.deepEqual(parseImageRef('registry.example.com:5000/team/app'), {
    registry: 'registry.example.com:5000',
    repository: 'team/app',
    reference: 'latest'
  });
});

test('image references that could escape the registry path are refused', () => {
  for (const bad of [
    '',
    'ghcr.io/../../etc/passwd',
    'ghcr.io/foo/..%2f..%2fbar',
    'ghcr.io/foo:bad tag',
    'ghcr.io/foo@notadigest',
    'ghcr.io/foo:../../x',
    'https://ghcr.io/foo',
    'user:pw@ghcr.io/foo',
    'ghcr.io/FOO',
    `ghcr.io/${'a'.repeat(600)}`
  ]) {
    assert.equal(parseImageRef(bad), null, bad);
  }
});

test('a single-arch OCI image returns its exposed port', async () => {
  const { net } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/1.0': () => imageManifest(),
    'https://ghcr.io/v2/org/app/blobs/sha256:cfg': () => imageConfig('9898/tcp')
  });
  const { result } = await inspect('ghcr.io/org/app:1.0', net);
  assert.deepEqual(result, { port: 9898, ports: [{ port: 9898, protocol: 'tcp' }] });
});

test('a multi-arch index resolves to the requested platform, skipping attestations', async () => {
  const { net, calls } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () =>
      json({
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          {
            digest: 'sha256:attest',
            platform: { os: 'unknown', architecture: 'unknown' },
            annotations: { 'vnd.docker.reference.type': 'attestation-manifest' }
          },
          { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
          { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }
        ]
      }),
    'https://ghcr.io/v2/org/app/manifests/sha256:arm': () => imageManifest('sha256:armcfg'),
    'https://ghcr.io/v2/org/app/blobs/sha256:armcfg': () => imageConfig('1111/tcp'),
    'https://ghcr.io/v2/org/app/manifests/sha256:amd': () => imageManifest('sha256:amdcfg'),
    'https://ghcr.io/v2/org/app/blobs/sha256:amdcfg': () => imageConfig('2222/tcp')
  });
  const amd = await inspect('ghcr.io/org/app', net);
  assert.equal(amd.result.port, 2222);
  assert.ok(!calls.some((c) => c.url.includes('attest')));

  const arm = await inspect('ghcr.io/org/app', net, { platform: 'linux/arm64' });
  assert.equal(arm.result.port, 1111);
});

test('an index without the wanted platform falls back to any real platform', async () => {
  const { net } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () =>
      json({
        manifests: [
          { digest: 'sha256:attest', platform: { os: 'unknown', architecture: 'unknown' } },
          { digest: 'sha256:win', platform: { os: 'windows', architecture: 'amd64' } }
        ]
      }),
    'https://ghcr.io/v2/org/app/manifests/sha256:win': () => imageManifest(),
    'https://ghcr.io/v2/org/app/blobs/sha256:cfg': () => imageConfig('3333/tcp')
  });
  assert.equal((await inspect('ghcr.io/org/app', net)).result.port, 3333);
});

test('docker hub short names run the anonymous token dance against library/', async () => {
  const seen: string[] = [];
  const { net, calls } = fakeNet({
    'https://registry-1.docker.io/v2/library/nginx/manifests/latest': (_url, headers) =>
      headers.authorization === 'Bearer anon'
        ? imageManifest()
        : challenge('https://auth.docker.io/token', 'registry.docker.io'),
    'https://auth.docker.io/token': (url, headers) => {
      seen.push(url.searchParams.get('scope') ?? '', url.searchParams.get('service') ?? '');
      assert.equal(headers.authorization, undefined);
      return json({ token: 'anon' });
    },
    'https://registry-1.docker.io/v2/library/nginx/blobs/sha256:cfg': (_url, headers) => {
      assert.equal(headers.authorization, 'Bearer anon');
      return redirect('https://production.cloudflare.docker.com/blob?sig=abc');
    },
    'https://production.cloudflare.docker.com/blob': (_url, headers) => {
      assert.equal(headers.authorization, undefined);
      return imageConfig('80/tcp');
    }
  });
  const { result } = await inspect('nginx', net);
  assert.equal(result.port, 80);
  assert.deepEqual(seen, ['repository:library/nginx:pull', 'registry.docker.io']);
  assert.ok(calls.every((c) => c.pinned));
});

test('a stored docker hub credential reaches auth.docker.io and nowhere else', async () => {
  const { net, calls } = fakeNet({
    'https://registry-1.docker.io/v2/team/private/manifests/latest': (_url, headers) =>
      headers.authorization === 'Bearer real'
        ? imageManifest()
        : challenge('https://auth.docker.io/token'),
    'https://auth.docker.io/token': (_url, headers) => {
      assert.equal(headers.authorization, SECRET_BASIC);
      return json({ access_token: 'real' });
    },
    'https://registry-1.docker.io/v2/team/private/blobs/sha256:cfg': () => imageConfig('8080/tcp')
  });
  const asked: string[] = [];
  const { result } = await inspect('team/private', net, {
    credentialFor: async (registry: string) => {
      asked.push(registry);
      return SECRET;
    }
  });
  assert.equal(result.port, 8080);
  assert.deepEqual(asked, ['docker.io']);
  const basic = calls.filter((c) => c.authorization === SECRET_BASIC);
  assert.deepEqual(
    basic.map((c) => c.host),
    ['auth.docker.io']
  );
});

test('basic-challenge registries get the credential on their own host only', async () => {
  const { net, calls } = fakeNet({
    'https://r.example.com/v2/app/manifests/latest': (_url, headers) =>
      headers.authorization === SECRET_BASIC
        ? imageManifest()
        : new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Basic realm="registry"' }
          }),
    'https://r.example.com/v2/app/blobs/sha256:cfg': (_url, headers) => {
      assert.equal(headers.authorization, SECRET_BASIC);
      return redirect('https://cdn.example.net/blob');
    },
    'https://cdn.example.net/blob': (_url, headers) => {
      assert.equal(headers.authorization, undefined);
      return imageConfig('5000/tcp');
    }
  });
  const { result } = await inspect('r.example.com/app', net, { credentialFor: async () => SECRET });
  assert.equal(result.port, 5000);
  assert.ok(calls.find((c) => c.host === 'cdn.example.net'));
});

test('a registry naming a foreign token realm never receives the stored credential', async () => {
  const { net, calls } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () => challenge('https://evil.example.org/t'),
    'https://evil.example.org/t': () => json({ token: 'attacker' })
  });
  const { result } = await inspect('ghcr.io/org/app', net, { credentialFor: async () => SECRET });
  assert.deepEqual(result, NONE);
  assert.ok(calls.some((c) => c.host === 'evil.example.org'));
  assert.ok(!calls.some((c) => c.authorization === SECRET_BASIC));
});

test('a same-host token realm that redirects away loses the credential', async () => {
  const { net, calls } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () => challenge('https://ghcr.io/token'),
    'https://ghcr.io/token': () => redirect('https://evil.example.org/t'),
    'https://evil.example.org/t': () => json({ token: 'x' })
  });
  await inspect('ghcr.io/org/app', net, { credentialFor: async () => SECRET });
  const leak = calls.find((c) => c.host === 'evil.example.org');
  assert.ok(leak);
  assert.equal(leak.authorization, undefined);
  assert.equal(
    calls.find((c) => c.url.startsWith('https://ghcr.io/token'))?.authorization,
    SECRET_BASIC
  );
});

test('a redirect to another host that then challenges does not pull the credential', async () => {
  const lookups: string[] = [];
  const { net, calls } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () =>
      redirect('https://evil.example.org/v2/capture'),
    'https://evil.example.org/v2/capture': () => challenge('https://evil.example.org/t'),
    'https://evil.example.org/t': () => json({ token: 'x' })
  });
  const { result } = await inspect('ghcr.io/org/app', net, {
    credentialFor: async (registry: string) => {
      lookups.push(registry);
      return SECRET;
    }
  });
  assert.deepEqual(result, NONE);
  assert.deepEqual(lookups, []);
  assert.ok(!calls.some((c) => c.host === 'evil.example.org' && c.authorization));
  assert.ok(!calls.some((c) => c.url.startsWith('https://evil.example.org/t')));
});

test('a credential is matched to the exact registry, port included', async () => {
  const asked: string[] = [];
  const { net } = fakeNet({
    'https://ghcr.io:8443/v2/org/app/manifests/latest': () =>
      challenge('https://ghcr.io:8443/token'),
    'https://ghcr.io:8443/token': () => json({ token: 'x' })
  });
  await inspect('ghcr.io:8443/org/app', net, {
    credentialFor: async (registry: string) => {
      asked.push(registry);
      return null;
    }
  });
  assert.deepEqual(asked, ['ghcr.io:8443']);
});

test('private, loopback, link-local and metadata destinations are refused before any fetch', async () => {
  for (const [image, dns] of [
    ['10.0.0.5/app', {}],
    ['127.0.0.1:5000/app', {}],
    ['169.254.169.254/latest', {}],
    ['192.168.1.1:5000/app', {}],
    ['100.100.100.200/app', {}],
    ['168.63.129.16/app', {}],
    ['localhost:5000/app', {}],
    ['kubernetes.default.svc.cluster.local/app', {}],
    ['harbor-core.harbor.svc/app', {}],
    ['metadata.google.internal/app', {}],
    ['rebind.example.org/app', { 'rebind.example.org': ['10.1.2.3'] }],
    ['mixed.example.org/app', { 'mixed.example.org': ['93.184.216.34', '127.0.0.1'] }],
    ['six.example.org/app', { 'six.example.org': ['::1'] }],
    ['ula.example.org/app', { 'ula.example.org': ['fd00:ec2::254'] }],
    ['mapped.example.org/app', { 'mapped.example.org': ['::ffff:169.254.169.254'] }],
    ['compat.example.org/app', { 'compat.example.org': ['::7f00:1'] }],
    ['nat64.example.org/app', { 'nat64.example.org': ['64:ff9b::a00:1'] }]
  ] as [string, Record<string, string[]>][]) {
    const { net, calls } = fakeNet({}, dns);
    const { result, failures } = await inspect(image, net);
    assert.deepEqual(result, NONE, image);
    assert.equal(calls.length, 0, image);
    assert.ok(failures[0]?.startsWith('blocked'), `${image}: ${failures[0]}`);
  }
});

test('the kubernetes api service address is refused even on an unusual service range', () => {
  const prior = process.env.KUBERNETES_SERVICE_HOST;
  process.env.KUBERNETES_SERVICE_HOST = '93.184.216.34';
  try {
    assert.equal(isRoutableRegistryAddress('93.184.216.34'), false);
    assert.equal(isRoutableRegistryAddress('8.8.8.8'), true);
  } finally {
    if (prior === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
    else process.env.KUBERNETES_SERVICE_HOST = prior;
  }
});

test('only global unicast IPv6 passes', () => {
  assert.equal(isRoutableRegistryAddress('2606:4700:4700::1111'), true);
  assert.equal(isRoutableRegistryAddress('2001:db8::1'), false);
  assert.equal(isRoutableRegistryAddress('2002:7f00:1::'), false);
  assert.equal(isRoutableRegistryAddress('fe80::1'), false);
  assert.equal(isRoutableRegistryAddress('::'), false);
});

test('a redirect to a private address is refused', async () => {
  for (const target of [
    'https://10.0.0.1/v2/x',
    'https://[::1]/v2/x',
    'https://2130706433/v2/x',
    'https://rebind.example.org/v2/x',
    'https://kubernetes.default.svc/v2/x',
    'http://ghcr.io/v2/x'
  ]) {
    const { net, calls } = fakeNet(
      { 'https://ghcr.io/v2/org/app/manifests/latest': () => redirect(target) },
      { 'rebind.example.org': ['192.168.0.10'] }
    );
    const { result, failures } = await inspect('ghcr.io/org/app', net);
    assert.deepEqual(result, NONE, target);
    assert.equal(calls.length, 1, target);
    assert.ok(failures[0]?.startsWith('blocked'), `${target}: ${failures[0]}`);
  }
});

test('redirects are capped at three', async () => {
  let hops = 0;
  const { net, calls } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () => redirect('/hop/1'),
    'https://ghcr.io/hop/1': () => {
      hops++;
      return redirect('/hop/2');
    },
    'https://ghcr.io/hop/2': () => redirect('/hop/3'),
    'https://ghcr.io/hop/3': () => redirect('/hop/4'),
    'https://ghcr.io/hop/4': () => imageManifest()
  });
  const { result, failures } = await inspect('ghcr.io/org/app', net);
  assert.deepEqual(result, NONE);
  assert.equal(hops, 1);
  assert.equal(calls.length, 4);
  assert.deepEqual(failures, ['too_many_redirects']);
});

test('a token realm on a private address is refused', async () => {
  for (const realm of [
    'https://10.0.0.1/token',
    'https://169.254.169.254/latest/meta-data',
    'http://auth.example.org/token',
    'https://u:p@auth.example.org/token',
    'https://auth.svc.cluster.local/token',
    'https://rebind.example.org/token'
  ]) {
    const { net, calls } = fakeNet(
      { 'https://ghcr.io/v2/org/app/manifests/latest': () => challenge(realm) },
      { 'rebind.example.org': ['172.16.0.9'] }
    );
    const { result, failures } = await inspect('ghcr.io/org/app', net, {
      credentialFor: async () => SECRET
    });
    assert.deepEqual(result, NONE, realm);
    assert.equal(calls.length, 1, realm);
    assert.ok(failures[0]?.startsWith('blocked'), `${realm}: ${failures[0]}`);
  }
});

test('a token realm that redirects to a private address is refused', async () => {
  const { net, calls } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () => challenge('https://ghcr.io/token'),
    'https://ghcr.io/token': () => redirect('https://192.168.0.1/token')
  });
  const { result } = await inspect('ghcr.io/org/app', net);
  assert.deepEqual(result, NONE);
  assert.equal(calls.length, 2);
});

test('plain http is only reachable for the configured hosts, port included', async () => {
  const plainHttpHosts = plainHttpHostsFrom(
    ' harbor-core.harbor.svc.cluster.local , 192.0.2.10:5000 '
  );
  const routes = {
    'http://harbor-core.harbor.svc.cluster.local/v2/orchard/app/manifests/latest': () =>
      imageManifest(),
    'http://harbor-core.harbor.svc.cluster.local/v2/orchard/app/blobs/sha256:cfg': () =>
      imageConfig('3000/tcp')
  };
  const listed = fakeNet(routes);
  const ok = await inspect('harbor-core.harbor.svc.cluster.local/orchard/app', listed.net, {
    plainHttpHosts
  });
  assert.equal(ok.result.port, 3000);
  assert.ok(listed.calls.every((c) => !c.pinned));
  assert.deepEqual(listed.resolved, []);

  const otherPort = fakeNet(routes);
  const refused = await inspect(
    'harbor-core.harbor.svc.cluster.local:8080/orchard/app',
    otherPort.net,
    {
      plainHttpHosts
    }
  );
  assert.deepEqual(refused.result, NONE);
  assert.equal(otherPort.calls.length, 0);

  const redirecting = fakeNet({
    'http://harbor-core.harbor.svc.cluster.local/v2/orchard/app/manifests/latest': () =>
      redirect('http://10.0.0.9/v2/x')
  });
  const bounced = await inspect(
    'harbor-core.harbor.svc.cluster.local/orchard/app',
    redirecting.net,
    {
      plainHttpHosts
    }
  );
  assert.deepEqual(bounced.result, NONE);
  assert.equal(redirecting.calls.length, 1);
});

test('oversized manifests and configs are dropped, declared or not', async () => {
  const big = 'x'.repeat(4096);
  const declared = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () =>
      new Response(big, { headers: { 'content-length': String(big.length) } })
  });
  assert.deepEqual((await inspect('ghcr.io/org/app', declared.net, { maxBytes: 1024 })).failures, [
    'too_large'
  ]);

  let cancelled = false;
  const undeclared = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () => imageManifest(),
    'https://ghcr.io/v2/org/app/blobs/sha256:cfg': () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(512));
          },
          cancel() {
            cancelled = true;
          }
        })
      )
  });
  const { result, failures } = await inspect('ghcr.io/org/app', undeclared.net, { maxBytes: 1024 });
  assert.deepEqual(result, NONE);
  assert.deepEqual(failures, ['too_large']);
  assert.equal(cancelled, true);
});

test('the default size cap is 2 MB', async () => {
  const { net } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () =>
      new Response(new Uint8Array(2 * 1024 * 1024 + 1))
  });
  assert.deepEqual((await inspect('ghcr.io/org/app', net)).failures, ['too_large']);
});

test('the whole lookup gives up at the deadline, stalled DNS included', async () => {
  const stalledFetch: RegistryNet = {
    resolve: async () => ['93.184.216.34'],
    fetch: () => new Promise<Response>(() => undefined)
  };
  const stalledDns: RegistryNet = {
    resolve: () => new Promise<string[]>(() => undefined),
    fetch: async () => new Response(null, { status: 500 })
  };
  for (const net of [stalledFetch, stalledDns]) {
    const started = Date.now();
    const { result, failures } = await inspect('ghcr.io/org/app', net, { timeoutMs: 50 });
    assert.deepEqual(result, NONE);
    assert.deepEqual(failures, ['timeout']);
    assert.ok(Date.now() - started < 2000);
  }
});

test('an image with no EXPOSE returns no ports', async () => {
  const empty = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () => imageManifest(),
    'https://ghcr.io/v2/org/app/blobs/sha256:cfg': () => json({ config: {} })
  });
  const { result, failures } = await inspect('ghcr.io/org/app', empty.net);
  assert.deepEqual(result, NONE);
  assert.deepEqual(failures, []);
});

test('every failure shape resolves to no ports without throwing', async () => {
  for (const [name, handler] of [
    ['404', () => new Response(null, { status: 404 })],
    ['garbage', () => new Response('<html>nope</html>')],
    ['array', () => json([])],
    ['no config', () => json({ schemaVersion: 2 })],
    ['evil digest', () => json({ config: { digest: '../../../etc/passwd' } })],
    [
      'throws',
      () => {
        throw new Error('https://ghcr.io/v2?token=secret failed');
      }
    ]
  ] as [string, Handler][]) {
    const { net } = fakeNet({ 'https://ghcr.io/v2/org/app/manifests/latest': handler });
    const { result, failures } = await inspect('ghcr.io/org/app', net);
    assert.deepEqual(result, NONE, name);
    assert.ok(
      failures.every((f) => /^[a-z0-9_]+$/.test(f)),
      `${name}: ${failures}`
    );
  }
  assert.deepEqual(await inspectImagePorts(undefined), NONE);
  assert.deepEqual(await inspectImagePorts(['nginx']), NONE);
});

test('a broken credential store still resolves to no ports', async () => {
  const { net } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () => challenge('https://ghcr.io/token')
  });
  const { result } = await inspect('ghcr.io/org/app', net, {
    credentialFor: async () => {
      throw new Error('decrypt failed');
    }
  });
  assert.deepEqual(result, NONE);
});

test('an endless index cannot recurse forever', async () => {
  const { net, calls } = fakeNet({
    'https://ghcr.io/v2/org/app/manifests/latest': () =>
      json({ manifests: [{ digest: 'sha256:loop', platform: { os: 'linux' } }] }),
    'https://ghcr.io/v2/org/app/manifests/sha256:loop': () =>
      json({ manifests: [{ digest: 'sha256:loop', platform: { os: 'linux' } }] })
  });
  const { failures } = await inspect('ghcr.io/org/app', net);
  assert.deepEqual(failures, ['index_too_deep']);
  assert.equal(calls.length, 3);
});

test('port choice prefers 80, then the lowest TCP port, and ignores UDP', () => {
  const ports = (...list: string[]) =>
    exposedPortsFrom({ config: { ExposedPorts: Object.fromEntries(list.map((p) => [p, {}])) } });
  assert.equal(chooseDefaultPort(ports('80/tcp', '443/tcp')), 80);
  assert.equal(chooseDefaultPort(ports('443/tcp', '8080/tcp')), 443);
  assert.equal(chooseDefaultPort(ports('9000/tcp', '3000/tcp')), 3000);
  assert.equal(chooseDefaultPort(ports('53/udp', '8080/tcp')), 8080);
  assert.equal(chooseDefaultPort(ports('80/udp', '8080/tcp')), 8080);
  assert.equal(chooseDefaultPort(ports('53/udp')), null);
  assert.equal(chooseDefaultPort(ports('8080')), 8080);
  assert.deepEqual(ports('53/udp', '53/tcp', '70000/tcp', 'junk', '0/tcp', '8080'), [
    { port: 53, protocol: 'tcp' },
    { port: 53, protocol: 'udp' },
    { port: 8080, protocol: 'tcp' }
  ]);
  assert.equal(chooseDefaultPort([]), null);
  assert.deepEqual(exposedPortsFrom(null), []);
  assert.deepEqual(exposedPortsFrom({ config: { ExposedPorts: ['80/tcp'] } }), []);
});

test('the reported port list is bounded against a hostile config', () => {
  const ExposedPorts = Object.fromEntries(
    Array.from({ length: 5000 }, (_, i) => [`${i + 1}/tcp`, {}])
  );
  assert.equal(exposedPortsFrom({ config: { ExposedPorts } }).length, 256);
});

test('the pinned connection refuses a name that rebinds to a private address after the check', async () => {
  let hit = false;
  const server = createServer((_req, res) => {
    hit = true;
    res.end('leak');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  let lookups = 0;
  const net = createRegistryNet(async () => {
    lookups++;
    return lookups === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
  });
  try {
    assert.deepEqual(await net.resolve('rebind.example.org'), ['93.184.216.34']);
    await assert.rejects(
      net.fetch(new URL(`http://rebind.example.org:${port}/v2/`), {
        headers: {},
        signal: AbortSignal.timeout(3000),
        pinned: true
      }),
      (err: any) =>
        /EBLOCKED|non-public/.test(String(err?.cause?.code ?? err?.cause?.message ?? err))
    );
    assert.equal(lookups, 2);
    assert.equal(hit, false);
  } finally {
    server.close();
  }
});

test('the pinned connection dials exactly the address its lookup approved', async () => {
  const server = createServer((_req, res) => res.end('reached'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const net = createRegistryNet(
    async () => ['127.0.0.1'],
    () => true
  );
  try {
    const res = await net.fetch(new URL(`http://name-only-the-lookup-knows.invalid:${port}/`), {
      headers: {},
      signal: AbortSignal.timeout(3000),
      pinned: true
    });
    assert.equal(await res.text(), 'reached');
  } finally {
    server.close();
  }
});

test('the pinned transport hands redirects back instead of following them', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/' });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const net = createRegistryNet(
    async () => ['127.0.0.1'],
    () => true
  );
  try {
    const res = await net.fetch(new URL(`http://r.invalid:${port}/`), {
      headers: {},
      signal: AbortSignal.timeout(3000),
      pinned: true
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://169.254.169.254/');
  } finally {
    server.close();
  }
});

function credentialFixture() {
  const prior = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = 'image-ports-test-encryption-key';
  const crypto = new SecretCryptoService();
  if (prior === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = prior;
  const projectRows = [
    { projectId: 'p1', registry: 'ghcr.io', username: 'proj', password: crypto.seal('proj-token') }
  ];
  const orgRows = [
    { organizationId: 'o1', registry: 'ghcr.io', username: 'org', password: crypto.encrypt('a') },
    { organizationId: 'o1', registry: 'quay.io', username: 'org', password: crypto.encrypt('b') },
    { organizationId: 'o2', registry: 'gcr.io', username: 'other', password: crypto.encrypt('c') }
  ];
  const match = (where: Record<string, string>) => (row: Record<string, string>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const prisma = {
    registryCredential: {
      findFirst: async ({ where }: any) => projectRows.find(match(where)) ?? null
    },
    organizationRegistryCredential: {
      findFirst: async ({ where }: any) => orgRows.find(match(where)) ?? null
    },
    project: { findUnique: async () => ({ organizationId: 'o1' }) }
  };
  return new RegistryCredentialsService(prisma as any, {} as any, crypto, {} as any);
}

test('credentials resolve project first, then the org, and only for the exact registry', async () => {
  const service = credentialFixture();
  assert.deepEqual(await service.pullCredential({ projectId: 'p1' }, 'ghcr.io'), {
    username: 'proj',
    password: 'proj-token'
  });
  assert.deepEqual(await service.pullCredential({ projectId: 'p1' }, 'quay.io'), {
    username: 'org',
    password: 'b'
  });
  assert.deepEqual(await service.pullCredential({ organizationId: 'o1' }, 'ghcr.io'), {
    username: 'org',
    password: 'a'
  });
  assert.equal(await service.pullCredential({ projectId: 'p1' }, 'gcr.io'), null);
  assert.equal(await service.pullCredential({ organizationId: 'o1' }, 'ghcr.io:8443'), null);
});

test('both routes carry the expensive-route rate limit', () => {
  for (const handler of [
    ImagePortsController.prototype.forProject,
    ImagePortsController.prototype.forOrganization
  ]) {
    assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', handler), 20);
    assert.equal(Reflect.getMetadata('THROTTLER:TTLdefault', handler), 60_000);
  }
});

test('the routes check access before touching the registry', async () => {
  const req = { user: { sub: 'u1', email: 'a@b.c' } };
  const denied = new Error('forbidden');
  const reads: unknown[] = [];
  const controller = new ImagePortsController(
    {
      detectImagePorts: async (image: unknown, scope: unknown) => {
        reads.push([image, scope]);
        return NONE;
      }
    } as any,
    {
      assertProjectEditAccess: async (id: string) => {
        if (id !== 'mine') throw denied;
        return {};
      },
      assertOrgCanCreateProjects: async (id: string) => {
        if (id !== 'mine') throw denied;
        return {};
      }
    } as any
  );
  await assert.rejects(controller.forProject('other', 'nginx', req), denied);
  await assert.rejects(controller.forOrganization('other', 'nginx', req), denied);
  assert.deepEqual(reads, []);
  await controller.forProject('mine', 'nginx', req);
  await controller.forOrganization('mine', 'nginx', req);
  assert.deepEqual(reads, [
    ['nginx', { projectId: 'mine' }],
    ['nginx', { organizationId: 'mine' }]
  ]);
});

test('the final base image follows stages and skips what cannot be inspected', () => {
  assert.equal(finalBaseImage('FROM nginx:1.27\nCOPY . /srv\n'), 'nginx:1.27');
  assert.equal(finalBaseImage('FROM node:22 AS build\nRUN x\nFROM nginx AS web\n'), 'nginx');
  assert.equal(finalBaseImage('FROM nginx AS base\nFROM node:22 AS build\nfrom base\n'), 'nginx');
  assert.equal(finalBaseImage('FROM --platform=linux/amd64 caddy:2\n'), 'caddy:2');
  assert.equal(finalBaseImage('ARG TAG=1\nFROM nginx:$TAG\n'), null);
  assert.equal(finalBaseImage('FROM golang AS build\nFROM scratch\n'), null);
  assert.equal(finalBaseImage('# nothing\n'), null);
});
