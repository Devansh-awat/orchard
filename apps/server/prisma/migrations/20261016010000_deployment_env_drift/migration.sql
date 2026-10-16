-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "env_conflicts" JSONB,
ADD COLUMN     "env_observed_hash" VARCHAR(64);

