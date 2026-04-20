-- Organization R2 backup settings
ALTER TABLE "organizations"
  ADD COLUMN "backup_r2_endpoint" VARCHAR(500),
  ADD COLUMN "backup_r2_bucket" VARCHAR(255),
  ADD COLUMN "backup_r2_region" VARCHAR(100),
  ADD COLUMN "backup_r2_access_key" VARCHAR(255),
  ADD COLUMN "backup_r2_secret_key" VARCHAR(500);

-- Database container-mode fields
ALTER TABLE "databases"
  ADD COLUMN "mode" VARCHAR(20) NOT NULL DEFAULT 'shared',
  ADD COLUMN "namespace" VARCHAR(100),
  ADD COLUMN "container_name" VARCHAR(100),
  ADD COLUMN "storage_size" VARCHAR(20);

-- Database backups
CREATE TABLE "database_backups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "database_id" UUID NOT NULL,
  "label" VARCHAR(255) NOT NULL,
  "backup_name" VARCHAR(255) NOT NULL,
  "type" VARCHAR(20) NOT NULL DEFAULT 'full',
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "size_bytes" BIGINT,
  "error_message" TEXT,
  "created_by" UUID,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(6),

  CONSTRAINT "database_backups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_database_backups_lookup" ON "database_backups" ("database_id", "created_at");

ALTER TABLE "database_backups"
  ADD CONSTRAINT "database_backups_database_id_fkey"
  FOREIGN KEY ("database_id") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
