-- CreateEnum
CREATE TYPE "SandboxRunnerKind" AS ENUM ('kubernetes', 'vercel');

-- CreateEnum
CREATE TYPE "SandboxDesiredState" AS ENUM ('running', 'stopped', 'deleted');

-- AlterTable
ALTER TABLE "sandboxes" ALTER COLUMN "namespace" DROP NOT NULL,
ADD COLUMN     "runner" "SandboxRunnerKind" NOT NULL DEFAULT 'kubernetes',
ADD COLUMN     "desired_state" "SandboxDesiredState" NOT NULL DEFAULT 'running',
ADD COLUMN     "external_id" VARCHAR(255),
ADD COLUMN     "runner_state" JSONB;

UPDATE "sandboxes" SET "desired_state" = 'stopped' WHERE "status" IN ('stopping', 'stopped');
UPDATE "sandboxes" SET "desired_state" = 'deleted' WHERE "status" = 'deleting';
UPDATE "sandboxes" AS s SET "desired_state" = 'stopped'
WHERE s."status" = 'error'
  AND EXISTS (
    SELECT 1 FROM "k8s_objects" AS o
    WHERE o."kind" = 'Sandbox'
      AND o."name" = s."pod_name"
      AND o."manifest"->'spec'->>'operatingMode' = 'Suspended'
  );

-- AlterTable
ALTER TABLE "k8s_apply_queue" ADD COLUMN     "sandbox_id" UUID;

-- CreateIndex
CREATE INDEX "idx_sandboxes_runner_status" ON "sandboxes"("runner", "status");

-- CreateIndex
CREATE INDEX "idx_k8s_apply_queue_sandbox" ON "k8s_apply_queue"("sandbox_id");
