-- AlterTable
ALTER TABLE "build_runs" ADD COLUMN "check_run_id" BIGINT,
ADD COLUMN "github_installation_id" BIGINT,
ADD COLUMN "repo_full_name" VARCHAR(255);
