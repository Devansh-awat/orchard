-- Project Environments (expand phase — retro-compatible).
--
-- This migration is intentionally EXPAND-ONLY so it is safe to apply while the
-- previous server version is still serving during a rolling deploy:
--   * every new column is nullable or has a DEFAULT, so the old code (which
--     doesn't know these columns) keeps INSERTing cleanly;
--   * environment_id is left NULLABLE — a later release tightens it to NOT NULL
--     once no old pods remain;
--   * the old (project_id, name) unique indexes are replaced by
--     (environment_id, name); NULL environment_id rows created by old code
--     never collide (Postgres treats NULLs as distinct), so old inserts still
--     succeed, while new code gets per-environment name uniqueness.

-- ---------------------------------------------------------------- Phase A: DDL
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "namespace" VARCHAR(100) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_production" BOOLEAN NOT NULL DEFAULT false,
    "cpu_limit_milli" INTEGER,
    "memory_limit_bytes" BIGINT,
    "max_pods" INTEGER,
    "max_services" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "environments_namespace_key" ON "environments"("namespace");
CREATE UNIQUE INDEX "environments_project_id_slug_key" ON "environments"("project_id", "slug");
CREATE INDEX "idx_environments_project" ON "environments"("project_id");
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "environment_shared_vars" (
    "id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environment_shared_vars_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "environment_shared_vars_environment_id_key_key" ON "environment_shared_vars"("environment_id", "key");
CREATE INDEX "idx_environment_shared_vars_environment" ON "environment_shared_vars"("environment_id");
ALTER TABLE "environment_shared_vars" ADD CONSTRAINT "environment_shared_vars_environment_id_fkey"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- secret flag on per-deployment env vars (DEFAULT keeps old inserts valid)
ALTER TABLE "deployment_env_vars" ADD COLUMN "secret" BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------ Phase B: one prod env per project
-- namespace = projects.namespace verbatim → the prod env inherits the exact
-- existing namespace, so no live k8s object is touched (zero churn).
INSERT INTO "environments"
    ("id", "project_id", "name", "slug", "namespace", "is_default", "is_production", "created_at", "updated_at")
SELECT gen_random_uuid(), p."id", 'Production', 'production', p."namespace", true, true, now(), now()
FROM "projects" p;

-- ------------------------- Phase C: nullable FK + backfill (no NOT NULL yet)
ALTER TABLE "deployments" ADD COLUMN "environment_id" UUID;
UPDATE "deployments" d SET "environment_id" = e."id"
    FROM "environments" e WHERE e."project_id" = d."project_id" AND e."is_default" = true;
CREATE INDEX "idx_deployments_environment" ON "deployments"("environment_id");
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_fkey"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "databases" ADD COLUMN "environment_id" UUID;
UPDATE "databases" d SET "environment_id" = e."id"
    FROM "environments" e WHERE e."project_id" = d."project_id" AND e."is_default" = true;
CREATE INDEX "idx_databases_environment" ON "databases"("environment_id");
ALTER TABLE "databases" ADD CONSTRAINT "databases_environment_id_fkey"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ingresses" ADD COLUMN "environment_id" UUID;
UPDATE "ingresses" i SET "environment_id" = e."id"
    FROM "environments" e WHERE e."project_id" = i."project_id" AND e."is_default" = true;
CREATE INDEX "idx_ingresses_environment" ON "ingresses"("environment_id");
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_environment_id_fkey"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "jobs" ADD COLUMN "environment_id" UUID;
UPDATE "jobs" j SET "environment_id" = e."id"
    FROM "environments" e WHERE e."project_id" = j."project_id" AND e."is_default" = true;
CREATE INDEX "idx_jobs_environment" ON "jobs"("environment_id");
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_environment_id_fkey"
    FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------- Phase D: flip name-uniqueness from project to environment
-- Enables the same deployment/database/job name across different environments.
DROP INDEX "deployments_project_id_name_key";
CREATE UNIQUE INDEX "deployments_environment_id_name_key" ON "deployments"("environment_id", "name");

DROP INDEX "databases_project_id_name_key";
CREATE UNIQUE INDEX "databases_environment_id_name_key" ON "databases"("environment_id", "name");

DROP INDEX "jobs_project_id_name_key";
CREATE UNIQUE INDEX "jobs_environment_id_name_key" ON "jobs"("environment_id", "name");
