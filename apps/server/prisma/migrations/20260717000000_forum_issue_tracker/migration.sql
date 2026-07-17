-- AlterTable
ALTER TABLE "forum_replies" ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "forum_threads" ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "number" SERIAL NOT NULL,
ADD COLUMN     "priority" VARCHAR(20) NOT NULL DEFAULT 'none';

-- CreateIndex
CREATE UNIQUE INDEX "forum_threads_number_key" ON "forum_threads"("number");

UPDATE "forum_threads" SET "status" = 'acknowledged' WHERE "status" = 'planned';
UPDATE "forum_threads" SET "status" = 'fixed' WHERE "status" = 'done';
UPDATE "forum_threads" SET "status" = 'wont-fix' WHERE "status" = 'declined';
