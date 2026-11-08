-- AlterTable
ALTER TABLE "users" ADD COLUMN     "scim_external_id" VARCHAR(255);

-- CreateTable
CREATE TABLE "instance_scim_tokens" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "created_by" UUID,
    "last_used_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instance_scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_scim_tokens_token_hash_key" ON "instance_scim_tokens"("token_hash");

