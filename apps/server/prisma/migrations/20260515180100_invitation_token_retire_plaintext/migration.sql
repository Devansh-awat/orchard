-- H-2 (invitations): Retire the plaintext `token` column. The hash backfill
-- shipped in 20260515150100 has populated `token_hash` for every row, so
-- application code now looks up by hash only. This migration finishes the
-- transition: NULL the plaintext on every existing row, drop NOT NULL on the
-- plaintext column, and promote `token_hash` to NOT NULL.

-- 1. Backfill any stragglers whose hash column is still NULL. The
--    20260515150100 migration already did this, but re-running the same
--    UPDATE is idempotent and protects against a pre-migration row that
--    slipped in via a hot deploy.
UPDATE "organization_invitations"
SET "token_hash" = encode(digest("token", 'sha256'), 'hex')
WHERE "token_hash" IS NULL AND "token" IS NOT NULL;

-- 2. Null the plaintext column for every row. The hash is the source of
--    truth — keeping the plaintext around indefinitely is a DB-leak hazard.
UPDATE "organization_invitations"
SET "token" = NULL
WHERE "token_hash" IS NOT NULL;

-- 3. Schema changes: plaintext column → nullable, hash column → NOT NULL.
ALTER TABLE "organization_invitations" ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "organization_invitations" ALTER COLUMN "token_hash" SET NOT NULL;
