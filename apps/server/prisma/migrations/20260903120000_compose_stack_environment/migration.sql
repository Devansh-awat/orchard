-- Compose stacks now remember which environment (and namespace) their child
-- deployments belong to, so create + redeploy keep them in the selected env
-- instead of always falling back to the project default.
ALTER TABLE "compose_stacks" ADD COLUMN "environment_id" UUID;

ALTER TABLE "compose_stacks"
  ADD CONSTRAINT "compose_stacks_environment_id_fkey"
  FOREIGN KEY ("environment_id") REFERENCES "environments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "idx_compose_stacks_environment" ON "compose_stacks"("environment_id");
