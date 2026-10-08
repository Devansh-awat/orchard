-- CreateTable
CREATE TABLE "user_integrations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "secret" TEXT,
    "external_id" VARCHAR(255),
    "workspace_name" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "user_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_link_tokens" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "team_id" VARCHAR(32) NOT NULL,
    "slack_user_id" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "used_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_integration_deliveries" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "delivery_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_integration_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_thread_links" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" VARCHAR(64) NOT NULL,
    "thread_ts" VARCHAR(64) NOT NULL,
    "saw_working" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_thread_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_integrations_user_provider" ON "user_integrations"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_integrations_provider_external" ON "user_integrations"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_slack_link_tokens_hash" ON "slack_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_slack_link_tokens_identity" ON "slack_link_tokens"("team_id", "slack_user_id");

-- CreateIndex
CREATE INDEX "idx_slack_link_tokens_expires" ON "slack_link_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sandbox_integration_deliveries" ON "sandbox_integration_deliveries"("provider", "delivery_id");

-- CreateIndex
CREATE INDEX "idx_sandbox_integration_deliveries_created" ON "sandbox_integration_deliveries"("created_at");

-- CreateIndex
CREATE INDEX "idx_slack_thread_links_pending" ON "slack_thread_links"("completed_at", "created_at");

-- CreateIndex
CREATE INDEX "idx_slack_thread_links_session" ON "slack_thread_links"("session_id");

-- AddForeignKey
ALTER TABLE "user_integrations" ADD CONSTRAINT "user_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sandbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
