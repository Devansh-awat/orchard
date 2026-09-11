import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceConfigService } from '../src/instance-config/instance-config.service';
import { STORAGE, EMAIL, NETWORK, WILDCARD } from '../src/instance-config/instance-config.sections';
import { objectStorage } from '../src/instance-config/object-storage';

class FakeSettings {
  rows = new Map<string, string>();

  async get(key: string) {
    return this.rows.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.rows.set(key, value);
  }

  async delete(key: string) {
    this.rows.delete(key);
  }
}

const fakeCrypto = {
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
};

function build() {
  const settings = new FakeSettings();
  const service = new InstanceConfigService(settings as any, fakeCrypto as any);
  return { settings, service };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const out = fn();
  return out instanceof Promise ? out.finally(restore) : (restore(), out);
}

test('a stored value is used when no environment variable is set', async () => {
  const { service } = build();
  await withEnv({ SMTP_HOST: undefined }, async () => {
    await service.save(EMAIL, { host: 'mail.example.com' });
    assert.equal(service.value(EMAIL, 'host'), 'mail.example.com');
    assert.equal(service.isConfigured(EMAIL), true);
  });
});

test('the environment always wins over a stored value and locks the field', async () => {
  const { service } = build();
  await withEnv({ SMTP_HOST: 'env.example.com' }, async () => {
    await service.save(EMAIL, { host: 'stored.example.com' });
    assert.equal(service.value(EMAIL, 'host'), 'env.example.com');
    assert.ok(service.lockedFields(EMAIL).includes('host'));
  });
});

test('a locked field cannot be overwritten through save', async () => {
  const { service, settings } = build();
  await withEnv({ SMTP_HOST: 'env.example.com' }, async () => {
    await service.save(EMAIL, { host: 'attempted.example.com', user: 'someone' });
    const raw = JSON.parse(settings.rows.get(EMAIL.key)!);
    assert.equal(raw.host, undefined);
    assert.equal(raw.user, 'someone');
  });
});

test('secrets are encrypted at rest and never returned to the client', async () => {
  const { service, settings } = build();
  await withEnv({ R2_SECRET_ACCESS_KEY: undefined }, async () => {
    await service.save(STORAGE, { secretAccessKey: 'super-secret' });
    const raw = JSON.parse(settings.rows.get(STORAGE.key)!);
    assert.equal(raw.secretAccessKey, 'enc:super-secret');
    assert.equal(service.value(STORAGE, 'secretAccessKey'), 'super-secret');
    assert.equal(service.state(STORAGE).values.secretAccessKey, '');
  });
});

test('an empty secret leaves the stored one alone', async () => {
  const { service } = build();
  await withEnv({ R2_SECRET_ACCESS_KEY: undefined, R2_BUCKET_NAME: undefined }, async () => {
    await service.save(STORAGE, { secretAccessKey: 'keep-me', bucketName: 'first' });
    await service.save(STORAGE, { secretAccessKey: '', bucketName: 'second' });
    assert.equal(service.value(STORAGE, 'secretAccessKey'), 'keep-me');
    assert.equal(service.value(STORAGE, 'bucketName'), 'second');
  });
});

test('every write bumps the generation so cached clients rebuild', async () => {
  const { service } = build();
  const before = service.generation;
  await service.save(EMAIL, { host: 'mail.example.com' });
  assert.ok(service.generation > before);
});

test('saving object storage reaches the readers that cannot inject the service', async () => {
  const { service } = build();
  await withEnv(
    { R2_ACCOUNT_ID: undefined, R2_ENDPOINT: undefined, R2_PUBLIC_URL: undefined },
    async () => {
      await service.save(STORAGE, { accountId: 'acct123' });
      assert.equal(objectStorage().endpoint, 'https://acct123.r2.cloudflarestorage.com');
      assert.equal(objectStorage().publicUrl, 'https://pub-acct123.r2.dev');
    },
  );
});

test('clearing a section falls back to the environment', async () => {
  const { service } = build();
  await withEnv({ SMTP_HOST: undefined }, async () => {
    await service.save(EMAIL, { host: 'stored.example.com' });
    await service.clear(EMAIL);
    assert.equal(service.value(EMAIL, 'host'), null);
    assert.equal(service.isConfigured(EMAIL), false);
  });
});

test('required fields decide whether a section counts as configured', async () => {
  const { service } = build();
  await withEnv(
    { R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined, R2_BUCKET_NAME: undefined },
    async () => {
      await service.save(STORAGE, { accessKeyId: 'a', bucketName: 'b' });
      assert.equal(service.isConfigured(STORAGE), false);
      await service.save(STORAGE, { secretAccessKey: 'c' });
      assert.equal(service.isConfigured(STORAGE), true);
    },
  );
});

test('wildcard domains parse from stored config when no variable is set', async () => {
  const { service } = build();
  await withEnv({ PLATFORM_WILDCARD_DOMAINS: undefined, APP_DOMAIN: undefined }, async () => {
    await service.save(WILDCARD, { domains: 'apps.example.com=wildcard-tls' });
    const { platformWildcardDomains } = await import('../src/projects/projects.utils');
    assert.deepEqual(platformWildcardDomains(), [
      { suffix: '.apps.example.com', secret: 'wildcard-tls' },
    ]);
  });
});

test('an ingress holding its own certificate moves onto a newly added wildcard', async () => {
  const { service } = build();
  await withEnv({ PLATFORM_WILDCARD_DOMAINS: undefined, APP_DOMAIN: undefined }, async () => {
    await service.save(WILDCARD, { domains: 'apps.example.com=wildcard-tls' });
    const { desiredWildcardTls } = await import('../src/projects/projects.utils');
    assert.deepEqual(
      desiredWildcardTls('app.apps.example.com', 'leaf-cert-abc', 'letsencrypt-prod'),
      { secretName: 'wildcard-tls', clusterIssuer: null },
    );
  });
});

test('an ingress already on the wildcard is left alone', async () => {
  const { service } = build();
  await withEnv({ PLATFORM_WILDCARD_DOMAINS: undefined, APP_DOMAIN: undefined }, async () => {
    await service.save(WILDCARD, { domains: 'apps.example.com=wildcard-tls' });
    const { desiredWildcardTls } = await import('../src/projects/projects.utils');
    assert.equal(
      desiredWildcardTls('app.apps.example.com', 'wildcard-tls', 'letsencrypt-prod'),
      null,
    );
  });
});

test('a custom domain keeps its own certificate when a wildcard exists elsewhere', async () => {
  const { service } = build();
  await withEnv({ PLATFORM_WILDCARD_DOMAINS: undefined, APP_DOMAIN: undefined }, async () => {
    await service.save(WILDCARD, { domains: 'apps.example.com=wildcard-tls' });
    const { desiredWildcardTls } = await import('../src/projects/projects.utils');
    assert.equal(desiredWildcardTls('www.customer.com', 'leaf-cert-abc', 'letsencrypt-prod'), null);
  });
});

test('removing the wildcard gives its ingresses a certificate of their own again', async () => {
  const { service } = build();
  await withEnv({ PLATFORM_WILDCARD_DOMAINS: undefined, APP_DOMAIN: undefined }, async () => {
    await service.save(WILDCARD, { domains: 'apps.example.com=wildcard-tls' });
    await service.clear(WILDCARD);
    const { desiredWildcardTls } = await import('../src/projects/projects.utils');
    assert.deepEqual(
      desiredWildcardTls('app.apps.example.com', 'wildcard-tls', 'letsencrypt-prod'),
      { secretName: null, clusterIssuer: 'letsencrypt-prod' },
    );
  });
});

test('an ingress with TLS switched off is never touched', async () => {
  const { desiredWildcardTls } = await import('../src/projects/projects.utils');
  assert.equal(desiredWildcardTls('app.apps.example.com', null, 'letsencrypt-prod'), null);
});

test('the instance public IP falls back to nothing until it is set', async () => {
  const { service } = build();
  await withEnv({ PUBLIC_EXPOSURE_IP: undefined }, async () => {
    assert.equal(service.defaultPublicIp(), '');
    await service.save(NETWORK, { publicIp: '203.0.113.10' });
    assert.equal(service.defaultPublicIp(), '203.0.113.10');
  });
});

test('the environment locks the instance public IP the same as every other field', async () => {
  const { service } = build();
  await withEnv({ PUBLIC_EXPOSURE_IP: '198.51.100.7' }, async () => {
    await service.save(NETWORK, { publicIp: '203.0.113.10' });
    assert.equal(service.defaultPublicIp(), '198.51.100.7');
    assert.deepEqual(service.lockedFields(NETWORK), ['publicIp']);
  });
});

// A typo here is published straight into a Service's loadBalancerIP, where the
// failure is a Service that never gets an address rather than a rejected save.
test('a public IP that is not an address is refused', async () => {
  const { service } = build();
  await withEnv({ PUBLIC_EXPOSURE_IP: undefined }, async () => {
    await assert.rejects(() => service.save(NETWORK, { publicIp: 'not-an-ip' }));
    assert.equal(service.defaultPublicIp(), '');
  });
});
