-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "queued_at" TIMESTAMP(6),
ADD COLUMN     "queued_commit_author_name" VARCHAR(255),
ADD COLUMN     "queued_commit_author_username" VARCHAR(255),
ADD COLUMN     "queued_commit_message" TEXT,
ADD COLUMN     "queued_commit_sha" VARCHAR(255);
