-- CreateEnum
CREATE TYPE "SandboxStatus" AS ENUM ('creating', 'starting', 'running', 'stopping', 'stopped', 'deleting', 'error');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "max_sandboxes" INTEGER;

-- CreateTable
CREATE TABLE "sandboxes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(63) NOT NULL,
    "status" "SandboxStatus" NOT NULL DEFAULT 'creating',
    "status_message" TEXT,
    "pod_name" VARCHAR(253) NOT NULL,
    "namespace" VARCHAR(253) NOT NULL,
    "image" VARCHAR(500) NOT NULL,
    "repo_url" VARCHAR(500),
    "ssh_public_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cpu_limit" VARCHAR(20) NOT NULL,
    "memory_limit" VARCHAR(20) NOT NULL,
    "disk_size" VARCHAR(20) NOT NULL,
    "last_active_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "claude_token" TEXT,
    "openai_token" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sandbox_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandboxes_pod_name_key" ON "sandboxes"("pod_name");

-- CreateIndex
CREATE INDEX "idx_sandboxes_status_active" ON "sandboxes"("status", "last_active_at");

-- CreateIndex
CREATE UNIQUE INDEX "sandboxes_user_id_name_key" ON "sandboxes"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_credentials_user_id_key" ON "sandbox_credentials"("user_id");

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_credentials" ADD CONSTRAINT "sandbox_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

