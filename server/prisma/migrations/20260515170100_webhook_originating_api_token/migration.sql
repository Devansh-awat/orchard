-- H-3: bind webhook tokens to the API token that minted them, so revoking
-- the parent API token (or removing the user) cascades to its webhooks.
-- Webhooks minted via session auth leave this column NULL.
ALTER TABLE "deployment_webhook_tokens"
  ADD COLUMN IF NOT EXISTS "originating_api_token_id" UUID;

ALTER TABLE "deployment_webhook_tokens"
  ADD CONSTRAINT "deployment_webhook_tokens_originating_api_token_id_fkey"
  FOREIGN KEY ("originating_api_token_id") REFERENCES "api_tokens"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_webhook_tokens_originating_api_token"
  ON "deployment_webhook_tokens" ("originating_api_token_id");
