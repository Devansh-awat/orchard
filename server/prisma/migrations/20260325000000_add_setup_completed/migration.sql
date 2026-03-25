-- AlterTable
ALTER TABLE "users" ADD COLUMN "setup_completed" BOOLEAN NOT NULL DEFAULT false;

-- Set existing users as already setup-completed
UPDATE "users" SET "setup_completed" = true;
