ALTER TABLE "databases" ADD COLUMN "r2_restore_access_key" VARCHAR(64),
ADD COLUMN "r2_restore_secret" VARCHAR(128),
ADD COLUMN "r2_restore_cluster_name" VARCHAR(100);

CREATE INDEX "idx_databases_r2_restore_access_key" ON "databases"("r2_restore_access_key");
