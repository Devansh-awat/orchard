import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InstanceSettingsService, MCP_ENABLED_KEY,
} from '../src/instance-settings/instance-settings.service';

class FakePrisma {
  rows = new Map<string, string>();

  instanceSetting = {
    findUnique: async ({ where }: any) => {
      const value = this.rows.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, update }: any) => {
      this.rows.set(where.key, update.value);
      return { key: where.key, value: update.value };
    },
  };
}

function build() {
  const prisma = new FakePrisma();
  return { prisma, settings: new InstanceSettingsService(prisma as any) };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// An upgraded instance has no row for this key, and MCP has always worked
// there. Reading a missing row as "off" would silently kill every existing
// agent connection on the release that added the toggle.
test('MCP is on when nothing has been stored', async () => {
  const { settings } = build();
  await withEnv({ MCP_ENABLED: undefined }, async () => {
    assert.equal(await settings.isMcpEnabled(), true);
    assert.deepEqual(await settings.getMcpState(), {
      enabled: true,
      dbValue: true,
      envOverride: null,
    });
  });
});

test('turning MCP off is remembered', async () => {
  const { settings } = build();
  await withEnv({ MCP_ENABLED: undefined }, async () => {
    await settings.setMcp(false);
    assert.equal(await settings.isMcpEnabled(), false);
    await settings.setMcp(true);
    assert.equal(await settings.isMcpEnabled(), true);
  });
});

test('the environment overrides the stored value and reports itself as the reason', async () => {
  const { settings } = build();
  await withEnv({ MCP_ENABLED: undefined }, async () => {
    await settings.setMcp(true);
  });
  await withEnv({ MCP_ENABLED: 'false' }, async () => {
    assert.equal(await settings.isMcpEnabled(), false);
    assert.deepEqual(await settings.getMcpState(), {
      enabled: false,
      dbValue: true,
      envOverride: false,
    });
  });
});

// A pinned toggle is read-only for everyone, not only for the panel that hides
// the switch. Storing the write changes nothing while the variable is set and
// then becomes the instance's answer the day it is unset.
test('a pinned toggle refuses the write instead of storing it', async () => {
  const { prisma, settings } = build();
  await withEnv({ MCP_ENABLED: 'false' }, async () => {
    await assert.rejects(() => settings.setMcp(true), /MCP_ENABLED/);
    assert.equal(prisma.rows.has(MCP_ENABLED_KEY), false);
  });
  await withEnv({ USERSPACE_NODE_SCHEDULING: 'true' }, async () => {
    await assert.rejects(
      () => settings.setUserspaceScheduling(false),
      /USERSPACE_NODE_SCHEDULING/,
    );
  });
});

// Userspace scheduling ships off, so it must not inherit the new default.
test('a toggle that ships off stays off when nothing has been stored', async () => {
  const { settings } = build();
  await withEnv({ USERSPACE_NODE_SCHEDULING: undefined }, async () => {
    assert.equal(await settings.isUserspaceSchedulingEnabled(), false);
  });
});
