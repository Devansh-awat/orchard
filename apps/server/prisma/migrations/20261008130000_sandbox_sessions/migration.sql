-- AlterTable
ALTER TABLE "sandbox_conversations" ADD COLUMN     "slug" VARCHAR(64),
ADD COLUMN     "branch" VARCHAR(255),
ADD COLUMN     "base_branch" VARCHAR(255),
ADD COLUMN     "base_commit" VARCHAR(64),
ADD COLUMN     "worktree_path" VARCHAR(500),
ADD COLUMN     "agent" VARCHAR(32) NOT NULL DEFAULT 'opencode',
ADD COLUMN     "opencode_session_id" VARCHAR(255),
ADD COLUMN     "pr_url" VARCHAR(500),
ADD COLUMN     "pr_number" INTEGER,
ADD COLUMN     "pr_state" VARCHAR(16),
ADD COLUMN     "preview_deployment_id" UUID,
ADD COLUMN     "preview_url" VARCHAR(500),
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "archived_at" TIMESTAMP(6);

-- CreateIndex
CREATE UNIQUE INDEX "uq_sandbox_conversations_sandbox_slug" ON "sandbox_conversations"("sandbox_id", "slug");

-- CreateIndex
CREATE INDEX "idx_sandbox_conversations_sandbox_archived" ON "sandbox_conversations"("sandbox_id", "archived_at");

-- AddForeignKey
ALTER TABLE "sandbox_conversations" ADD CONSTRAINT "sandbox_conversations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
