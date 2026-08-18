-- CreateTable
CREATE TABLE "mcp_oauth_codes" (
    "id" VARCHAR(191) NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL DEFAULT '',
    "code_challenge" TEXT,
    "code_challenge_method" VARCHAR(16),
    "orchard_token" TEXT NOT NULL DEFAULT '',
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_mcp_oauth_codes_expires_at" ON "mcp_oauth_codes"("expires_at");
