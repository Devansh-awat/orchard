-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "external_repo_id" VARCHAR(120),
ADD COLUMN     "git_connection_id" UUID;

-- CreateTable
CREATE TABLE "git_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "base_url" VARCHAR(500) NOT NULL,
    "username" VARCHAR(255),
    "token" TEXT NOT NULL,
    "webhook_secret" VARCHAR(128) NOT NULL,
    "oauth" BOOLEAN NOT NULL DEFAULT false,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "git_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_git_connections_user" ON "git_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "git_connections_user_id_name_key" ON "git_connections"("user_id", "name");

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_git_connection_id_fkey" FOREIGN KEY ("git_connection_id") REFERENCES "git_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

