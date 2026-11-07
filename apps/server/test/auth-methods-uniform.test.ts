import test from 'node:test';
import assert from 'node:assert/strict';
import { PasswordlessController } from '../src/auth/passwordless.controller';

function build(passwordHolder: boolean) {
  const lookups: unknown[] = [];
  const prisma: any = {
    user: {
      findFirst: async (args: unknown) => {
        lookups.push(args);
        return passwordHolder ? { id: 'u' } : null;
      },
      findUnique: async (args: unknown) => {
        lookups.push(args);
        return null;
      }
    }
  };
  const controller = Object.assign(Object.create(PasswordlessController.prototype), {
    prisma,
    otpService: { sendsEmail: () => true },
    passkeyService: {
      userHasPasskeys: async (args: unknown) => {
        lookups.push(args);
        return false;
      }
    }
  }) as PasswordlessController;
  return { controller, lookups };
}

test('/auth/methods does not depend on the email and never reports superadmin', async () => {
  const { controller } = build(true);
  const first = await (controller as any).authMethods({ query: { email: 'ceo@example.com' } });
  const second = await (controller as any).authMethods({ query: { email: 'nobody@example.com' } });
  assert.deepEqual(first, second);
  assert.ok(!('superadmin' in first));
  assert.deepEqual(first, { passkey: true, password: true });
});

test('/auth/methods only looks at instance-level state', async () => {
  const { controller, lookups } = build(false);
  const result = await (controller as any).authMethods({ query: { email: 'ceo@example.com' } });
  assert.deepEqual(result, { passkey: true, password: false });
  assert.ok(!JSON.stringify(lookups).includes('ceo@example.com'));
});

test('/auth/passkey/check gives every address the same answer', async () => {
  const { controller, lookups } = build(false);
  const a = await (controller as any).checkPasskeys({ query: { email: 'a@example.com' } });
  const b = await (controller as any).checkPasskeys({ query: { email: 'b@example.com' } });
  assert.deepEqual(a, b);
  assert.equal(lookups.length, 0);
});
