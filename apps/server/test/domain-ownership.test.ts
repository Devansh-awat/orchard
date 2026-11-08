import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  DomainRegistrationService,
  classifyDomain,
  registrationFromRdap
} from '../src/auth/domain-registration';
import { MISSING_GRACE_MS, OrgDomainsService } from '../src/sso/org-domains.service';
import { DOMAIN_CHANGED_HANDS, OtpService } from '../src/auth/otp.service';
import { hashOtpCode } from '../src/auth/otp-code';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const DAY = 24 * 60 * 60_000;

test('only a registrable ICANN domain counts as ownable', () => {
  assert.equal(classifyDomain('bigcorp.co.uk').kind, 'registrable');
  assert.equal(classifyDomain('mail.bigcorp.com').registrable, 'bigcorp.com');
  assert.equal(classifyDomain('co.uk').kind, 'public_suffix');
  assert.equal(classifyDomain('github.io').kind, 'private_suffix');
  assert.equal(classifyDomain('evil.vercel.app').kind, 'private_suffix');
  assert.equal(classifyDomain('10.0.0.1').kind, 'invalid');
});

test('an organization cannot claim a public suffix or a platform subdomain', () => {
  const svc = new OrgDomainsService({} as any, {} as any);
  for (const bad of ['co.uk', 'github.io', 'myco.vercel.app', 'foo.blogspot.com']) {
    assert.throws(() => svc.normalizeDomain(bad), BadRequestException, bad);
  }
  assert.equal(svc.normalizeDomain('https://Acme.co.uk/login'), 'acme.co.uk');
});

test('RDAP registration date parsing ignores other events and junk', () => {
  assert.equal(
    registrationFromRdap({
      events: [
        { eventAction: 'last changed', eventDate: '2025-01-01T00:00:00Z' },
        { eventAction: 'registration', eventDate: '2024-03-02T10:00:00Z' }
      ]
    })?.toISOString(),
    '2024-03-02T10:00:00.000Z'
  );
  assert.equal(registrationFromRdap({ events: [{ eventAction: 'registration' }] }), null);
  assert.equal(registrationFromRdap('nope'), null);
});

test('changedHandsSince is only true on a positive, later registration date', async () => {
  const reg = new DomainRegistrationService();
  const verified = new Date('2024-01-01T00:00:00Z');
  (reg as any).registeredAt = async () => new Date('2025-06-01T00:00:00Z');
  assert.equal(await reg.changedHandsSince('acme.com', verified), true);
  (reg as any).registeredAt = async () => new Date('2010-06-01T00:00:00Z');
  assert.equal(await reg.changedHandsSince('acme.com', verified), false);
  (reg as any).registeredAt = async () => undefined;
  assert.equal(await reg.changedHandsSince('acme.com', verified), false, 'unknown is not proof');
});

function domainsWorld(opts: {
  registeredAt?: Date | undefined;
  txt?: string[] | Error;
  row?: Record<string, unknown>;
}) {
  const verifiedAt = new Date('2024-01-01T00:00:00Z');
  const row: any = {
    id: 'd1',
    organizationId: 'org1',
    domain: 'acme.com',
    verificationToken: 'orchard-verify-old',
    verifiedAt,
    registeredAt: new Date('2015-01-01T00:00:00Z'),
    missingSince: null,
    lastError: null,
    ...opts.row
  };
  const audits: any[] = [];
  const prisma: any = {
    orgDomain: {
      update: async ({ data }: any) => Object.assign(row, data)
    }
  };
  const svc = new OrgDomainsService(
    prisma,
    { log: async (e: any) => audits.push(e) } as any,
    {
      registeredAt: async () => opts.registeredAt
    } as any
  );
  svc.lookupChallenge = async () => {
    if (opts.txt instanceof Error) throw opts.txt;
    return opts.txt ?? [];
  };
  return { svc, row, audits };
}

const dnsError = (code: string) => Object.assign(new Error(code), { code });

test('a re-registered domain loses its verification at once, even with the old TXT copied back', async () => {
  const { svc, row, audits } = domainsWorld({
    registeredAt: new Date('2025-02-01T00:00:00Z'),
    txt: ['orchard-verify-old']
  });
  assert.equal(await svc.recheck(row), 'revoked');
  assert.equal(row.verifiedAt, null);
  assert.notEqual(row.verificationToken, 'orchard-verify-old', 'the old token must stop working');
  assert.equal(audits[0].action, 'org.domain.revoked');
});

test('a DNS outage never revokes a verified domain', async () => {
  const { svc, row } = domainsWorld({ txt: dnsError('ESERVFAIL') });
  assert.equal(await svc.recheck(row), 'unknown');
  assert.notEqual(row.verifiedAt, null);
  assert.equal(row.missingSince, null);
});

test('a removed TXT record gets a grace period, then revokes', async () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const { svc, row } = domainsWorld({ txt: dnsError('ENOTFOUND') });
  assert.equal(await svc.recheck(row, now), 'missing');
  assert.notEqual(row.verifiedAt, null);
  assert.equal(row.missingSince.getTime(), now.getTime());

  assert.equal(await svc.recheck(row, new Date(now.getTime() + DAY)), 'missing');
  assert.notEqual(row.verifiedAt, null);

  assert.equal(await svc.recheck(row, new Date(now.getTime() + MISSING_GRACE_MS)), 'revoked');
  assert.equal(row.verifiedAt, null);
});

test('putting the TXT record back inside the grace period clears the warning', async () => {
  const { svc, row } = domainsWorld({
    txt: ['orchard-verify-old'],
    row: { missingSince: new Date(Date.now() - DAY), lastError: 'missing' }
  });
  assert.equal(await svc.recheck(row), 'kept');
  assert.equal(row.missingSince, null);
  assert.equal(row.lastError, null);
});

function otpWorld(user: Record<string, unknown> | null, registeredAt: Date | undefined) {
  const db: any = {
    user: { findUnique: async () => user, update: async () => ({}) },
    otpCode: {
      findFirst: async () => ({ id: 'o1', code: hashOtpCode('123456') }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({})
    }
  };
  db.$transaction = async (fn: any) => fn(db);
  const limits = {
    checkRateLimits: async () => ({ pressured: false }),
    slowDown: async () => {},
    resetRateLimit: async () => {}
  };
  return new OtpService(
    db,
    {} as any,
    limits as any,
    {
      changedHandsSince: async (_d: string, since: Date) =>
        Boolean(registeredAt && registeredAt.getTime() > since.getTime())
    } as any
  );
}

test('an email code cannot sign into an account whose domain was re-registered after verification', async () => {
  const otp = otpWorld(
    {
      id: 'u1',
      emailVerified: true,
      emailVerifiedAt: new Date('2023-05-01T00:00:00Z'),
      createdAt: new Date('2023-05-01T00:00:00Z')
    },
    new Date('2025-09-01T00:00:00Z')
  );
  await assert.rejects(
    otp.verifyOtp('ceo@lapsed.example', '123456', '1.1.1.1'),
    (err: any) => err instanceof ForbiddenException && err.message === DOMAIN_CHANGED_HANDS
  );
});

test('an email code still works when the domain is older than the account or RDAP is silent', async () => {
  const account = {
    id: 'u1',
    emailVerified: true,
    emailVerifiedAt: new Date('2023-05-01T00:00:00Z'),
    createdAt: new Date('2023-05-01T00:00:00Z')
  };
  const older = otpWorld(account, new Date('2010-01-01T00:00:00Z'));
  assert.equal((await older.verifyOtp('a@acme.example', '123456', '1.1.1.1')).valid, true);
  const silent = otpWorld(account, undefined);
  assert.equal((await silent.verifyOtp('a@acme.example', '123456', '1.1.1.1')).valid, true);
  const fresh = otpWorld(null, new Date());
  assert.equal((await fresh.verifyOtp('new@acme.example', '123456', '1.1.1.1')).valid, true);
});
