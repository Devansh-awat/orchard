import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadGraftOwned,
  ownedDrops,
  statements,
  unexpectedStatements
} from '../scripts/check-migration-drift.mjs';

const owned = loadGraftOwned();

test('graft-owned leftovers are tolerated', () => {
  const sql = `
-- DropForeignKey
ALTER TABLE "public"."forum_replies" DROP CONSTRAINT "forum_replies_author_id_fkey";

-- DropTable
DROP TABLE "public"."sandboxes";

-- DropEnum
DROP TYPE "public"."SandboxStatus";
`;
  assert.equal(statements(sql).length, 3);
  assert.deepEqual(unexpectedStatements(sql, owned), []);
});

test('a committed drop of a graft-owned table is caught', () => {
  assert.equal(ownedDrops('DROP TABLE "public"."forum_threads";', owned).length, 1);
  assert.equal(ownedDrops('DROP TYPE "SandboxStatus";', owned).length, 1);
  assert.equal(ownedDrops('DROP TABLE "notifications";', owned).length, 0);
});

test('an empty diff is clean', () => {
  assert.deepEqual(unexpectedStatements('\n-- This is an empty migration.\n', owned), []);
});

test('dropping or altering anything core is reported', () => {
  const sql = `
DROP TABLE "public"."users";
ALTER TABLE "public"."api_tokens" DROP CONSTRAINT "api_tokens_user_id_fkey";
DROP TYPE "public"."ProjectRole";
ALTER TABLE "api_tokens" ADD COLUMN "parent_token_id" UUID;
`;
  assert.equal(unexpectedStatements(sql, owned).length, 4);
});
