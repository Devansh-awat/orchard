ALTER TABLE "databases"
  ADD COLUMN "cluster_name" VARCHAR(100),
  ADD COLUMN "pg_parameters" JSONB,
  ADD COLUMN "shared_preload_libs" JSONB,
  ADD COLUMN "installed_extensions" JSONB;
