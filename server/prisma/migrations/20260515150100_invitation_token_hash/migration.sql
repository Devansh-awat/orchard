-- M-3 (invitations): Store a SHA-256 hash of the invitation token at rest so
-- a DB read (backup leak, SQLi, read replica access) does not yield working
-- invitation links. The plaintext token still ships in the invite email — only
-- the hash is persisted/looked-up. The legacy `token` column is retained
-- during the transition window so unconsumed invites issued before this
-- migration continue to work; new code paths look up by `token_hash`.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "organization_invitations" ADD COLUMN "token_hash" VARCHAR(128);

-- Backfill: hash every existing plaintext token in place so lookups by hash
-- resolve old invitations too.
UPDATE "organization_invitations"
SET "token_hash" = encode(digest("token", 'sha256'), 'hex')
WHERE "token_hash" IS NULL;

CREATE UNIQUE INDEX "organization_invitations_token_hash_key"
  ON "organization_invitations"("token_hash");
