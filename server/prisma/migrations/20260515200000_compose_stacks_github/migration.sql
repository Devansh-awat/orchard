-- AlterTable
ALTER TABLE "compose_stacks"
    ADD COLUMN "github_repo" VARCHAR(500),
    ADD COLUMN "github_branch" VARCHAR(255),
    ADD COLUMN "compose_path" VARCHAR(500),
    ADD COLUMN "github_installation_id" BIGINT,
    ADD COLUMN "auto_deploy_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auto_deploy_branch" VARCHAR(255),
    ADD COLUMN "last_commit_sha" VARCHAR(64),
    ADD COLUMN "build_status" VARCHAR(50) NOT NULL DEFAULT 'none',
    ADD COLUMN "build_logs" TEXT;

-- CreateIndex
CREATE INDEX "idx_compose_stacks_github" ON "compose_stacks"("github_installation_id", "github_repo");
