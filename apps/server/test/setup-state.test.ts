import { test } from 'node:test';
import assert from 'node:assert';
import { SetupService } from '../src/setup/setup.service';

// The governing rule of the first-run gate: no skip may leave Orchard unusable.
// A step whose absence breaks the instance is either unskippable, or is done
// for the user and demoted to customisation. These tests hold that rule against
// the API directly, because a rule enforced only in the client is not a rule.

function serviceWith(counts: {
  passkeys?: number;
  orgs?: number;
  orgName?: string;
  deployments?: number;
  skipped?: string[];
}) {
  const state = {
    passkeys: counts.passkeys ?? 0,
    orgs: counts.orgs ?? 0,
    orgName: counts.orgName ?? 'Leafd',
    deployments: counts.deployments ?? 0,
    skipped: counts.skipped ?? ([] as string[]),
  };
  const svc = Object.create(SetupService.prototype) as any;
  svc.logger = { warn() {}, error() {} };
  svc.admin = { createOrganization: async () => ({ id: 'o1' }) };
  svc.prisma = {
    user: {
      findUnique: async () => ({ id: 'u1', email: 'hi@leafd.dev', setupSkipped: state.skipped }),
      update: async ({ data }: any) => { state.skipped = data.setupSkipped; return {}; },
    },
    passkey: { count: async () => state.passkeys },
    organization: {
      findMany: async () => Array.from({ length: state.orgs }, () => ({ name: state.orgName })),
      findUnique: async () => null,
    },
    organizationMember: { count: async () => state.orgs },
    deployment: { count: async () => state.deployments },
  };
  return { svc: svc as SetupService, state };
}

const byId = (s: any, id: string) => s.steps.find((x: any) => x.id === id);

// The org exists from the moment the instance is claimed, so "has an org"
// cannot be what marks this step done or it would never render, and nobody
// would ever meet the concept.
test('an org still carrying its derived name leaves the step outstanding', async () => {
  const { svc } = serviceWith({ orgs: 1, orgName: 'Leafd' });
  const s = await svc.getSetupState('u1');
  assert.equal(byId(s, 'organization').done, false);
});

test('renaming the org settles the step', async () => {
  const { svc } = serviceWith({ orgs: 1, orgName: 'Coolest Startup' });
  const s = await svc.getSetupState('u1');
  assert.equal(byId(s, 'organization').done, true);
});

test('a freshly claimed instance still needs the passkey', async () => {
  const { svc } = serviceWith({ orgs: 1 });
  const s = await svc.getSetupState('u1');
  assert.equal(byId(s, 'passkey').done, false);
  assert.equal(s.complete, false);
});

test('the passkey step cannot be skipped, even by calling the API directly', async () => {
  const { svc } = serviceWith({ orgs: 1 });
  await assert.rejects(() => svc.skipSetupStep('u1', 'passkey'), /cannot be skipped/);
});

test('an unknown step is rejected rather than silently recorded', async () => {
  const { svc } = serviceWith({ orgs: 1 });
  await assert.rejects(() => svc.skipSetupStep('u1', 'backups'), /cannot be skipped/);
});

test('skipping everything skippable still leaves a usable instance', async () => {
  // Usable means: the org exists. Registering the passkey is the only thing the
  // operator must do, and after that the gate completes with nothing else set up.
  const { svc, state } = serviceWith({ orgs: 1, passkeys: 1 });
  await svc.skipSetupStep('u1', 'organization');
  const s = await svc.skipSetupStep('u1', 'deploy');

  assert.equal(s.complete, true);
  assert.equal(state.orgs, 1, 'the org survives being skipped');
  assert.equal(byId(s, 'deploy').skipped, true);
});

test('the gate never completes while the passkey is missing', async () => {
  const { svc } = serviceWith({ orgs: 1 });
  await svc.skipSetupStep('u1', 'organization');
  const s = await svc.skipSetupStep('u1', 'deploy');
  assert.equal(s.complete, false);
  assert.equal(byId(s, 'passkey').required, true);
});

// Derived, not stored: deleting your last passkey has to reopen the step rather
// than leaving a stale "done" behind.
test('done flags follow reality rather than a stored flag', async () => {
  const { svc } = serviceWith({ orgs: 1, orgName: 'Renamed', passkeys: 0, deployments: 3 });
  const s = await svc.getSetupState('u1');
  assert.equal(byId(s, 'passkey').done, false);
  assert.equal(byId(s, 'deploy').done, true);
});

// The invariant has to hold for accounts that predate the auto-creation and for
// the claim path taken while already signed in, not only at first claim.
test('an account with no org gets one when its setup state is read', async () => {
  const { svc, state } = serviceWith({ orgs: 0 });
  let created = 0;
  (svc as any).admin = {
    createOrganization: async () => {
      created += 1;
      state.orgs = 1;
      return { id: 'o1' };
    }
  };
  await svc.getSetupState('u1');
  assert.equal(created, 1);
});

// Skipping the org step is only safe because an org exists. If creation failed,
// completing anyway would strand the account with nothing it can create.
test('setup cannot complete without an organization', async () => {
  const { svc } = serviceWith({ orgs: 0, passkeys: 1 });
  (svc as any).admin = { createOrganization: async () => { throw new Error('nope'); } };
  await svc.skipSetupStep('u1', 'organization');
  const s = await svc.skipSetupStep('u1', 'deploy');
  assert.equal(s.complete, false);
});

test('skips are idempotent', async () => {
  const { svc, state } = serviceWith({ orgs: 1 });
  await svc.skipSetupStep('u1', 'deploy');
  await svc.skipSetupStep('u1', 'deploy');
  assert.deepEqual(state.skipped, ['deploy']);
});
