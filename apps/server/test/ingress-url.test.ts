import test from 'node:test';
import assert from 'node:assert/strict';
import { ingressPublicUrl, ingressTlsEnabled, scrubIngress } from '../src/projects/projects.utils';

/**
 * Clients used to build `https://${host}` themselves, which is wrong twice
 * over: a lan install can serve on ports other than 80 and 443, and an ingress
 * with no certificate is not necessarily plaintext. The hostname alone cannot
 * answer either question, so the API answers both.
 */

function withPorts(http: string | undefined, https: string | undefined, run: () => void) {
  const before = [process.env.PUBLIC_HTTP_PORT, process.env.PUBLIC_HTTPS_PORT];
  if (http === undefined) delete process.env.PUBLIC_HTTP_PORT;
  else process.env.PUBLIC_HTTP_PORT = http;
  if (https === undefined) delete process.env.PUBLIC_HTTPS_PORT;
  else process.env.PUBLIC_HTTPS_PORT = https;
  try {
    run();
  } finally {
    if (before[0] === undefined) delete process.env.PUBLIC_HTTP_PORT;
    else process.env.PUBLIC_HTTP_PORT = before[0];
    if (before[1] === undefined) delete process.env.PUBLIC_HTTPS_PORT;
    else process.env.PUBLIC_HTTPS_PORT = before[1];
  }
}

test('a certificate means TLS, whatever the entrypoints say', () => {
  assert.equal(ingressTlsEnabled({ tlsSecretName: 'app-tls', entrypoints: ['web'] }), true);
});

test('without a certificate the entrypoint decides', () => {
  assert.equal(ingressTlsEnabled({ tlsSecretName: null, entrypoints: ['web'] }), false);
  assert.equal(ingressTlsEnabled({ tlsSecretName: null, entrypoints: ['websecure'] }), true);
});

test('an ingress that says nothing is assumed to be TLS', () => {
  assert.equal(ingressTlsEnabled({}), true);
  assert.equal(ingressTlsEnabled({ entrypoints: [] }), true);
});

test('standard ports stay out of the URL', () => {
  withPorts(undefined, undefined, () => {
    assert.equal(
      ingressPublicUrl({ host: 'app.example.com', path: '/', tlsSecretName: 'tls' }),
      'https://app.example.com/'
    );
  });
  withPorts('80', '443', () => {
    assert.equal(
      ingressPublicUrl({ host: 'app.example.com', path: '', tlsSecretName: 'tls' }),
      'https://app.example.com'
    );
  });
});

test('a lan install on custom ports gets them in the URL', () => {
  withPorts('8080', '8443', () => {
    assert.equal(
      ingressPublicUrl({ host: 'app.example.com', path: '/', tlsSecretName: 'tls' }),
      'https://app.example.com:8443/'
    );
    assert.equal(
      ingressPublicUrl({ host: 'app.example.com', path: '/', entrypoints: ['web'] }),
      'http://app.example.com:8080/'
    );
  });
});

test('a path already inside the host keeps its place', () => {
  withPorts('8080', '8443', () => {
    assert.equal(
      ingressPublicUrl({ host: 'app.example.com/api', path: '', tlsSecretName: 'tls' }),
      'https://app.example.com:8443/api'
    );
  });
});

test('no host means no URL', () => {
  assert.equal(ingressPublicUrl({ host: '' }), '');
  assert.equal(ingressPublicUrl({ host: null }), '');
});

test('scrubbing keeps the secrets out and puts the URL in', () => {
  withPorts('8080', '8443', () => {
    const scrubbed = scrubIngress({
      id: 'ing1',
      host: 'app.example.com',
      path: '/',
      tlsSecretName: 'app-tls',
      entrypoints: ['websecure'],
      protectionPasswordHash: 'secret',
      protectionBypassSecret: 'secret'
    });
    assert.equal(scrubbed.url, 'https://app.example.com:8443/');
    assert.equal(scrubbed.tlsEnabled, true);
    assert.ok(!('protectionPasswordHash' in scrubbed));
    assert.ok(!('protectionBypassSecret' in scrubbed));
  });
});
