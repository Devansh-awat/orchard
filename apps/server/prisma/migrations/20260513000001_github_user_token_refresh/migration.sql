-- Add GitHub user token expiry + refresh token columns
ALTER TABLE "users"
  ADD COLUMN "github_token_expires_at" TIMESTAMP(6),
  ADD COLUMN "github_refresh_token" TEXT,
  ADD COLUMN "github_refresh_token_expires_at" TIMESTAMP(6);
