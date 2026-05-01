-- Add commit author and build timing fields to image_history
ALTER TABLE "image_history"
  ADD COLUMN "commit_author_name" VARCHAR(255),
  ADD COLUMN "commit_author_username" VARCHAR(255),
  ADD COLUMN "build_started_at" TIMESTAMP(6),
  ADD COLUMN "build_completed_at" TIMESTAMP(6);
