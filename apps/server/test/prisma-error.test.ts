import test from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { isMalformedIdError, prismaHttpException } from '../src/prisma/prisma-error';

const malformed = Object.assign(
  new Error(
    'Inconsistent column data: Error creating UUID, invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `r` at 2'
  ),
  { name: 'PrismaClientKnownRequestError', code: 'P2023' }
);

test('a slug where a uuid belongs is a 404, not a 500', () => {
  assert.equal(isMalformedIdError(malformed), true);
  assert.ok(prismaHttpException(malformed) instanceof NotFoundException);
});

test('other prisma errors still surface as themselves', () => {
  const missing = Object.assign(new Error('Record to update not found.'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2025'
  });
  const otherP2023 = Object.assign(new Error('Inconsistent column data: bad json'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2023'
  });
  assert.equal(prismaHttpException(missing), null);
  assert.equal(prismaHttpException(otherP2023), null);
  assert.equal(prismaHttpException(new Error('boom')), null);
});
