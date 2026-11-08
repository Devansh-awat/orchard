-- AlterTable
ALTER TABLE "mcp_oauth_clients" ADD COLUMN     "last_used_at" TIMESTAMP(6);

-- CreateIndex
CREATE INDEX "idx_error_group_last_seen" ON "error_groups"("last_seen_at");

