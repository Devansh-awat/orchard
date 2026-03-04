-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "health_check_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deployments" ADD COLUMN "health_check_path" VARCHAR(500);
ALTER TABLE "deployments" ADD COLUMN "health_check_port" INTEGER;
ALTER TABLE "deployments" ADD COLUMN "health_check_type" VARCHAR(20) NOT NULL DEFAULT 'http';
ALTER TABLE "deployments" ADD COLUMN "health_check_command" VARCHAR(500);
ALTER TABLE "deployments" ADD COLUMN "liveness_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "deployments" ADD COLUMN "readiness_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "deployments" ADD COLUMN "startup_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deployments" ADD COLUMN "health_check_interval" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "deployments" ADD COLUMN "health_check_timeout" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "deployments" ADD COLUMN "health_check_retries" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "deployments" ADD COLUMN "startup_failure_threshold" INTEGER NOT NULL DEFAULT 30;
