-- CreateTable
CREATE TABLE "build_runs" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    "trigger_type" VARCHAR(20) NOT NULL,
    "commit_sha" VARCHAR(255),
    "commit_message" TEXT,
    "commit_author_name" VARCHAR(255),
    "commit_author_username" VARCHAR(255),
    "branch" VARCHAR(255),
    "triggered_by_id" UUID,
    "worker_id" VARCHAR(120),
    "heartbeat_at" TIMESTAMP(6),
    "detail" TEXT,
    "scheduled_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "build_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_build_runs_claim" ON "build_runs"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "idx_build_runs_deployment_status" ON "build_runs"("deployment_id", "status");

-- CreateIndex
CREATE INDEX "idx_build_runs_deployment_recent" ON "build_runs"("deployment_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_build_runs_reclaim" ON "build_runs"("status", "heartbeat_at");

-- AddForeignKey
ALTER TABLE "build_runs" ADD CONSTRAINT "build_runs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_runs" ADD CONSTRAINT "build_runs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
