-- GitHub App installations are shared, org-level resources on GitHub's side.
-- Decouple them from individual user ownership so they survive user deletion
-- and work for any user who has GitHub access to the relevant repos.

ALTER TABLE "github_app_installations"
  ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "github_app_installations"
  DROP CONSTRAINT "github_app_installations_user_id_fkey";

ALTER TABLE "github_app_installations"
  ADD CONSTRAINT "github_app_installations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_github_app_installations_account_id"
  ON "github_app_installations"("account_id");
