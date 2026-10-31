-- AlterTable
ALTER TABLE "databases" ADD COLUMN     "backup_method" VARCHAR(20),
ADD COLUMN     "backup_server_name" VARCHAR(100),
ADD COLUMN     "ddl_checkpoints" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ddl_guard_version" INTEGER,
ADD COLUMN     "deletion_protection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "forked_at" TIMESTAMP(6),
ADD COLUMN     "forked_from_id" UUID,
ADD COLUMN     "pooler_config" JSONB,
ADD COLUMN     "pooler_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "restore_tests" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "database_backups" ADD COLUMN     "barman_id" VARCHAR(64),
ADD COLUMN     "begin_lsn" VARCHAR(32),
ADD COLUMN     "destination_path" VARCHAR(500),
ADD COLUMN     "end_lsn" VARCHAR(32),
ADD COLUMN     "method" VARCHAR(20),
ADD COLUMN     "server_name" VARCHAR(100),
ADD COLUMN     "started_at" TIMESTAMP(6);

-- CreateTable
CREATE TABLE "database_operations" (
    "id" UUID NOT NULL,
    "database_id" UUID,
    "kind" VARCHAR(20) NOT NULL,
    "mode" VARCHAR(20),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "phase" VARCHAR(40) NOT NULL DEFAULT 'queued',
    "target" JSONB NOT NULL,
    "source" JSONB NOT NULL,
    "target_namespace" VARCHAR(63),
    "target_cluster_name" VARCHAR(63),
    "target_database_id" UUID,
    "storage_access_key" VARCHAR(64),
    "request" JSONB,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_by" UUID,
    "deadline_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "database_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_checkpoints" (
    "id" UUID NOT NULL,
    "database_id" UUID NOT NULL,
    "group_id" UUID,
    "label" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "restore_point_name" VARCHAR(64) NOT NULL,
    "lsn" VARCHAR(32),
    "wal_file" VARCHAR(40),
    "server_name" VARCHAR(100),
    "detail" TEXT,
    "deployment_id" UUID,
    "release_id" VARCHAR(100),
    "created_by" UUID,
    "error" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durable_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),
    "hidden_at" TIMESTAMP(6),

    CONSTRAINT "database_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_databases" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "environment_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "namespace" VARCHAR(63) NOT NULL,
    "cluster_name" VARCHAR(63) NOT NULL,
    "backup_server_name" VARCHAR(100) NOT NULL,
    "destination_path" VARCHAR(500) NOT NULL,
    "pg_major" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "recoverable_until" TIMESTAMP(6),
    "deleted_by" UUID,
    "deleted_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purge_after" TIMESTAMP(6) NOT NULL,
    "purged_at" TIMESTAMP(6),
    "restored_as" UUID,

    CONSTRAINT "deleted_databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_access_keys" (
    "access_key" VARCHAR(64) NOT NULL,
    "secret" VARCHAR(128) NOT NULL,
    "organization_id" UUID NOT NULL,
    "write_prefix" VARCHAR(255) NOT NULL,
    "read_prefixes" TEXT[],
    "purpose" VARCHAR(40) NOT NULL,
    "operation_id" UUID,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_access_keys_pkey" PRIMARY KEY ("access_key")
);

-- CreateIndex
CREATE INDEX "idx_database_operations_database" ON "database_operations"("database_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_database_operations_status" ON "database_operations"("status", "kind");

-- CreateIndex
CREATE INDEX "idx_database_checkpoints_database" ON "database_checkpoints"("database_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_database_checkpoints_group" ON "database_checkpoints"("group_id");

-- CreateIndex
CREATE INDEX "idx_database_checkpoints_status" ON "database_checkpoints"("status");

-- CreateIndex
CREATE UNIQUE INDEX "database_checkpoints_database_id_restore_point_name_key" ON "database_checkpoints"("database_id", "restore_point_name");

-- CreateIndex
CREATE INDEX "idx_deleted_databases_project" ON "deleted_databases"("project_id", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_deleted_databases_org" ON "deleted_databases"("organization_id", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_deleted_databases_purge" ON "deleted_databases"("purge_after");

-- CreateIndex
CREATE INDEX "idx_storage_access_keys_expiry" ON "storage_access_keys"("expires_at");

-- AddForeignKey
ALTER TABLE "deleted_databases" ADD CONSTRAINT "deleted_databases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

