-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN "started_at" TIMESTAMP(6);

-- Rows already running when this lands have no recorded start; seed them from
-- their last activity so the max-lifetime sweep has something to measure.
UPDATE "sandboxes" SET "started_at" = "last_active_at" WHERE "status" = 'running';
