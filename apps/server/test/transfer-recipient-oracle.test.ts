import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { ProjectsService } from '../src/projects/projects.service';

function build() {
  const queried: string[] = [];
  const prisma: any = {
    user: {
      findUnique: async () => {
        queried.push('user');
        return { id: 'u1', email: 'someone@example.com', username: 'someone' };
      }
    },
    projectMember: {
      findFirst: async ({ where }: any) => {
        queried.push('projectMember');
        const email = where.user.email;
        const id = where.user.id;
        if (where.projectId === 'p1' && (email === 'member@example.com' || id === 'u2')) {
          return {
            id: 'm1',
            roleId: 'r1',
            role: { name: 'admin' },
            user: { id: 'u2', email: 'member@example.com', username: 'member' }
          };
        }
        return null;
      }
    }
  };
  const service = Object.assign(Object.create(ProjectsService.prototype), { prisma });
  return { service: service as any, queried };
}

async function message(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error: any) {
    assert.ok(error instanceof BadRequestException);
    return error.message as string;
  }
  assert.fail('expected rejection');
}

test('unknown accounts and non-members are indistinguishable', async () => {
  const { service, queried } = build();
  const stranger = await message(
    service.resolveTransferRecipient('p1', { email: 'someone@example.com' })
  );
  const nobody = await message(
    service.resolveTransferRecipient('p1', { email: 'nobody@example.com' })
  );
  const unknownId = await message(service.resolveTransferRecipient('p1', { userId: 'ghost' }));
  assert.equal(stranger, nobody);
  assert.equal(stranger, unknownId);
  assert.ok(!queried.includes('user'));
});

test('a project member still resolves', async () => {
  const { service } = build();
  const result = await service.resolveTransferRecipient('p1', { email: 'Member@Example.com' });
  assert.equal(result.user.id, 'u2');
  assert.equal(result.membership.id, 'm1');
});
