-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "apply_error" TEXT,
ADD COLUMN     "apply_status" VARCHAR(20) NOT NULL DEFAULT 'synced';

-- CreateTable
CREATE TABLE "k8s_apply_queue" (
    "id" UUID NOT NULL,
    "dedupe_key" VARCHAR(300) NOT NULL,
    "op_type" VARCHAR(40) NOT NULL,
    "manifest" JSONB,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "not_before" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_by" VARCHAR(120),
    "claimed_at" TIMESTAMP(6),
    "last_error" TEXT,
    "deployment_id" UUID,
    "requested_by_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "k8s_apply_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "k8s_apply_queue_dedupe_key_key" ON "k8s_apply_queue"("dedupe_key");

-- CreateIndex
CREATE INDEX "idx_k8s_apply_queue_status_not_before" ON "k8s_apply_queue"("status", "not_before");

-- CreateIndex
CREATE INDEX "idx_k8s_apply_queue_deployment" ON "k8s_apply_queue"("deployment_id");

