-- Org-level: default per-member resource allowance handed to new members.
ALTER TABLE "organizations"
  ADD COLUMN "default_member_cpu_milli" INTEGER,
  ADD COLUMN "default_member_memory_bytes" BIGINT;

-- Per-member allowance + explicit "unlimited" flags.
ALTER TABLE "organization_members"
  ADD COLUMN "cpu_allowance_milli" INTEGER,
  ADD COLUMN "memory_allowance_bytes" BIGINT,
  ADD COLUMN "cpu_allowance_unlimited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "memory_allowance_unlimited" BOOLEAN NOT NULL DEFAULT false;

-- Project owner — deployments roll up to this user's allowance.
ALTER TABLE "projects" ADD COLUMN "owner_id" UUID;

-- Backfill ownership from the original creator.
UPDATE "projects" SET "owner_id" = "created_by" WHERE "owner_id" IS NULL;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
