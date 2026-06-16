-- H-3 (webhooks): Store a SHA-256 hash of webhook bearer tokens at rest.
-- Plaintext storage turned a DB-read foothold into working triggers; the
-- bearer still ships in the response when the token is created, but only
-- the hash is persisted/queried afterwards. Pattern mirrors the invitation
-- token hash migration (20260515150100).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Add the hash column nullable so we can backfill before applying the
--    NOT NULL constraint.
ALTER TABLE "deployment_webhook_tokens" ADD COLUMN "token_hash" VARCHAR(128);

-- 2. Backfill every existing row.
UPDATE "deployment_webhook_tokens"
SET "token_hash" = encode(digest("token", 'sha256'), 'hex')
WHERE "token_hash" IS NULL AND "token" IS NOT NULL;

-- 3. Null the plaintext column for backfilled rows — the hash is now the
--    source of truth and the plaintext is a sitting liability.
UPDATE "deployment_webhook_tokens"
SET "token" = NULL
WHERE "token_hash" IS NOT NULL;

-- 4. Drop the NOT NULL constraint on the plaintext column so future rows
--    can write NULL there. (Postgres: previously NOT NULL by schema.)
ALTER TABLE "deployment_webhook_tokens" ALTER COLUMN "token" DROP NOT NULL;

-- 5. Enforce NOT NULL + uniqueness on the hash column.
ALTER TABLE "deployment_webhook_tokens" ALTER COLUMN "token_hash" SET NOT NULL;
CREATE UNIQUE INDEX "deployment_webhook_tokens_token_hash_key"
  ON "deployment_webhook_tokens"("token_hash");
