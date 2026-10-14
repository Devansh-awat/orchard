ALTER TABLE "sandbox_credentials" ADD COLUMN IF NOT EXISTS "ai_gateway_token" TEXT;

CREATE TABLE IF NOT EXISTS "sandbox_chats" (
    "id" VARCHAR(64) NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "agent" VARCHAR(32) NOT NULL,
    "title" VARCHAR(200) NOT NULL DEFAULT 'New chat',
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_chats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sandbox_chats_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "sandbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_sandbox_chats_conversation" ON "sandbox_chats"("conversation_id");
CREATE INDEX IF NOT EXISTS "idx_sandbox_chats_sandbox" ON "sandbox_chats"("sandbox_id");
