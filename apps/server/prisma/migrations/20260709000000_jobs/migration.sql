-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "schedule_cron" VARCHAR(100),
    "time_zone" VARCHAR(64),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "concurrency_policy" VARCHAR(20) NOT NULL DEFAULT 'forbid',
    "run_timeout_seconds" INTEGER NOT NULL DEFAULT 21600,
    "cronjob_name" VARCHAR(63),
    "run_counter" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_steps" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "deployment_id" UUID,
    "image" VARCHAR(500),
    "command" JSONB,
    "script" TEXT,
    "script_runtime" VARCHAR(20),
    "env_vars" JSONB NOT NULL DEFAULT '[]',
    "cpu_request_milli" INTEGER,
    "memory_request_bytes" BIGINT,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 1800,
    "retries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "job_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "trigger" VARCHAR(20) NOT NULL,
    "triggered_by" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "steps_snapshot" JSONB NOT NULL,
    "current_step_order" INTEGER,
    "error_message" TEXT,
    "scheduled_for" TIMESTAMP(6),
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_run_steps" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "resolved_image" VARCHAR(500),
    "command" JSONB,
    "k8s_job_name" VARCHAR(63),
    "k8s_job_uid" VARCHAR(64),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "exit_code" INTEGER,
    "reason" VARCHAR(255),
    "logs" TEXT,
    "logs_truncated" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),

    CONSTRAINT "job_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_jobs_project" ON "jobs"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_project_id_name_key" ON "jobs"("project_id", "name");

-- CreateIndex
CREATE INDEX "idx_job_steps_job" ON "job_steps"("job_id");

-- CreateIndex
CREATE INDEX "idx_job_steps_deployment" ON "job_steps"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_steps_job_id_step_order_key" ON "job_steps"("job_id", "step_order");

-- CreateIndex
CREATE INDEX "idx_job_runs_job_created" ON "job_runs"("job_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_job_runs_status" ON "job_runs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_job_id_number_key" ON "job_runs"("job_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "job_run_steps_k8s_job_uid_key" ON "job_run_steps"("k8s_job_uid");

-- CreateIndex
CREATE INDEX "idx_job_run_steps_run" ON "job_run_steps"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_run_steps_run_id_step_order_key" ON "job_run_steps"("run_id", "step_order");


-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_triggered_by_fkey" FOREIGN KEY ("triggered_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_run_steps" ADD CONSTRAINT "job_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "job_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

