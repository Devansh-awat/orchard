-- CreateTable
CREATE TABLE "sandbox_share_links" (
    "id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "session_id" UUID,
    "created_by_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(6),
    "revoked_at" TIMESTAMP(6),
    "last_used_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_sandbox_share_links_token_hash" ON "sandbox_share_links"("token_hash");

-- CreateIndex
CREATE INDEX "idx_sandbox_share_links_sandbox" ON "sandbox_share_links"("sandbox_id");

-- CreateIndex
CREATE INDEX "idx_sandbox_share_links_session" ON "sandbox_share_links"("session_id");

-- AddForeignKey
ALTER TABLE "sandbox_share_links" ADD CONSTRAINT "sandbox_share_links_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_share_links" ADD CONSTRAINT "sandbox_share_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sandbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_share_links" ADD CONSTRAINT "sandbox_share_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
