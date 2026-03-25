-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "build_status" VARCHAR(50) NOT NULL DEFAULT 'none';

-- Backfill: deployments currently in 'building' or 'pending' status get build_status='building'
UPDATE "deployments" SET "build_status" = 'building' WHERE "status" IN ('building', 'pending');

-- Backfill: deployments that completed a build (have buildLogs and are running) get build_status='succeeded'
UPDATE "deployments" SET "build_status" = 'succeeded' WHERE "status" = 'running' AND "build_logs" IS NOT NULL AND "github_repo" IS NOT NULL;

-- Backfill: failed deployments with build errors get build_status='failed'
UPDATE "deployments" SET "build_status" = 'failed' WHERE "status" = 'failed' AND "build_error" IS NOT NULL;

-- Fix status for deployments that were 'building' - they should have a runtime status of 'pending'
UPDATE "deployments" SET "status" = 'pending' WHERE "status" = 'building';
