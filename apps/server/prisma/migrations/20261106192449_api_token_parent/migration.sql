-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN     "parent_token_id" UUID;

-- CreateIndex
CREATE INDEX "idx_api_tokens_parent" ON "api_tokens"("parent_token_id");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_parent_token_id_fkey" FOREIGN KEY ("parent_token_id") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

