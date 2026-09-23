-- AlterEnum
ALTER TYPE "deployment_strategy" ADD VALUE 'blueGreen';

-- CreateTable
CREATE TABLE "releases" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "image_history_id" UUID,
    "image" VARCHAR(500) NOT NULL,
    "strategy" "deployment_strategy" NOT NULL DEFAULT 'rollingUpdate',
    "status" VARCHAR(20) NOT NULL DEFAULT 'live',
    "reason" TEXT,
    "env_snapshot" JSONB NOT NULL,
    "resource_snapshot" JSONB NOT NULL,
    "health_check_snapshot" JSONB,
    "start_command" VARCHAR(2000),
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promoted_at" TIMESTAMP(6),
    "superseded_at" TIMESTAMP(6),

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_releases_deployment_recent" ON "releases"("deployment_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_releases_deployment_status" ON "releases"("deployment_id", "status");

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_image_history_id_fkey" FOREIGN KEY ("image_history_id") REFERENCES "image_history"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

