-- CreateTable
CREATE TABLE "deployment_webhook_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "label" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(6),

    CONSTRAINT "deployment_webhook_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deployment_webhook_tokens_token_key" ON "deployment_webhook_tokens"("token");

-- CreateIndex
CREATE INDEX "idx_webhook_tokens_deployment" ON "deployment_webhook_tokens"("deployment_id");

-- AddForeignKey
ALTER TABLE "deployment_webhook_tokens" ADD CONSTRAINT "deployment_webhook_tokens_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
