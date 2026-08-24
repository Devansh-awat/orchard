-- AlterTable
ALTER TABLE "users" ADD COLUMN "image_source" VARCHAR(20);
ALTER TABLE "users" ADD COLUMN "avatar_checked_at" TIMESTAMP(6);

-- Existing pictures were all manual uploads, so mark them as such. Anything
-- still null is due an email-avatar lookup on next sign-in.
UPDATE "users" SET "image_source" = 'upload' WHERE "image_url" IS NOT NULL;
