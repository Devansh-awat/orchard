-- Hash existing plaintext API tokens at rest and add capability scopes.
-- A DB read (SQLi, backup leak, read replica) no longer yields working
-- credentials; the bearer string is hashed on every authn instead.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "api_tokens" ADD COLUMN "token_hash" VARCHAR(128);
ALTER TABLE "api_tokens" ADD COLUMN "scopes" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "api_tokens"
SET "token_hash" = encode(digest("token", 'sha256'), 'hex')
WHERE "token_hash" IS NULL;

ALTER TABLE "api_tokens" ALTER COLUMN "token_hash" SET NOT NULL;

DROP INDEX IF EXISTS "idx_api_tokens_token";
DROP INDEX IF EXISTS "api_tokens_token_key";

CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");
CREATE INDEX "idx_api_tokens_token_hash" ON "api_tokens"("token_hash");

ALTER TABLE "api_tokens" DROP COLUMN "token";
