import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { beginHostClaim } from '../src/projects/host-claim';
import { ProjectAccessService } from '../src/projects/project-access.service';

function world() {
  const committed = {
    ingresses: [] as { host: string; projectId: string }[],
    subdomains: new Set<string>()
  };
  const log: string[] = [];
  let tail: Promise<void> = Promise.resolve();

  const prisma = {
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((r) => (unlock = r));
      const pending: (() => void)[] = [];
      const tx = {
        async $executeRaw() {
          await previous;
          log.push('lock');
        },
        ingress: {
          findFirst: async ({ where }: any) =>
            committed.ingresses.find(
              (i) => i.host === where.host.equals && i.projectId !== where.NOT.projectId
            ) ?? null,
          create: async ({ data }: any) => {
            log.push(`create:${data.host}`);
            pending.push(() =>
              committed.ingresses.push({ host: data.host, projectId: data.projectId })
            );
            return data;
          }
        },
        organization: {
          findUnique: async ({ where }: any) =>
            committed.subdomains.has(where.subdomain) ? { id: 'o' } : null
        },
        statusPage: { findUnique: async () => null }
      };
      try {
        const out = await fn(tx);
        pending.forEach((p) => p());
        log.push('commit');
        return out;
      } finally {
        unlock();
      }
    }
  };
  return { prisma, committed, log };
}

function access(prisma: any) {
  const svc = Object.create(ProjectAccessService.prototype) as ProjectAccessService;
  (svc as any).prisma = prisma;
  return svc;
}

test('two custom-domain claims for one host serialize and the second loses', async () => {
  const { prisma, log } = world();
  const svc = access(prisma);
  const check = (project: string) => (tx: any) =>
    svc.assertHostnameUnclaimed('shop.example.com', project, tx);

  const a = await beginHostClaim(prisma, check('p1'));
  const bPromise = beginHostClaim(prisma, check('p2'));
  await a.tx.ingress.create({ data: { host: 'shop.example.com', projectId: 'p1' } });
  await a.close(true);
  await assert.rejects(bPromise, ConflictException);
  assert.deepEqual(log.slice(0, 4), ['lock', 'create:shop.example.com', 'commit', 'lock']);
});

test('a rolled back claim releases the host for the next claim', async () => {
  const { prisma, committed } = world();
  const svc = access(prisma);
  const check = (project: string) => (tx: any) =>
    svc.assertHostnameUnclaimed('shop.example.com', project, tx);

  const a = await beginHostClaim(prisma, check('p1'));
  const bPromise = beginHostClaim(prisma, check('p2'));
  await a.tx.ingress.create({ data: { host: 'shop.example.com', projectId: 'p1' } });
  await a.close(false);
  const b = await bPromise;
  await b.close(true);
  assert.equal(committed.ingresses.length, 0);
});

test('a claim sees a vanity subdomain committed before it took the lock', async () => {
  const { prisma, committed } = world();
  const svc = access(prisma);
  process.env.BASE_DOMAIN = 'orchard.my';
  try {
    committed.subdomains.add('acme');
    await assert.rejects(
      beginHostClaim(prisma, (tx) => svc.assertHostnameUnclaimed('acme.orchard.my', 'p1', tx)),
      ConflictException
    );
  } finally {
    delete process.env.BASE_DOMAIN;
  }
});
