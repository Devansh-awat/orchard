-- CreateEnum
CREATE TYPE "SandboxMemberRole" AS ENUM ('viewer', 'collaborator');

-- CreateTable
CREATE TABLE "sandbox_members" (
    "id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "SandboxMemberRole" NOT NULL,
    "invited_by_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sandbox_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_prompt_authors" (
    "id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "session_id" UUID,
    "opencode_session_id" VARCHAR(64) NOT NULL,
    "message_id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_prompt_authors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_session_messages" (
    "id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "chat_id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_session_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_sandbox_members_user" ON "sandbox_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sandbox_members_sandbox_user" ON "sandbox_members"("sandbox_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_sandbox_prompt_authors_chat" ON "sandbox_prompt_authors"("sandbox_id", "opencode_session_id");

-- CreateIndex
CREATE INDEX "idx_sandbox_prompt_authors_session" ON "sandbox_prompt_authors"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sandbox_prompt_authors_message" ON "sandbox_prompt_authors"("sandbox_id", "message_id");

-- CreateIndex
CREATE INDEX "idx_sandbox_session_messages_session" ON "sandbox_session_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_sandbox_session_messages_sandbox" ON "sandbox_session_messages"("sandbox_id");

-- AddForeignKey
ALTER TABLE "sandbox_members" ADD CONSTRAINT "sandbox_members_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_members" ADD CONSTRAINT "sandbox_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_members" ADD CONSTRAINT "sandbox_members_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_prompt_authors" ADD CONSTRAINT "sandbox_prompt_authors_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_prompt_authors" ADD CONSTRAINT "sandbox_prompt_authors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_session_messages" ADD CONSTRAINT "sandbox_session_messages_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_session_messages" ADD CONSTRAINT "sandbox_session_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sandbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_session_messages" ADD CONSTRAINT "sandbox_session_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

