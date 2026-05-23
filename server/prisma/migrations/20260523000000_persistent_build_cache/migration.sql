-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "persistent_build_cache" BOOLEAN NOT NULL DEFAULT false;
