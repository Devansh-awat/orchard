-- AlterTable
ALTER TABLE "sandboxes" DROP COLUMN "chat_session_id";

-- CreateTable
CREATE TABLE "sandbox_conversations" (
    "id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "repo" VARCHAR(120),
    "claude_session_id" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sandbox_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_sandbox_conversations_sandbox" ON "sandbox_conversations"("sandbox_id");

-- AddForeignKey
ALTER TABLE "sandbox_conversations" ADD CONSTRAINT "sandbox_conversations_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

