-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "dockerfile_health_check" JSONB,
ADD COLUMN     "health_check_override" BOOLEAN NOT NULL DEFAULT false;
