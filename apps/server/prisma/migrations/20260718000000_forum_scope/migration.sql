-- AlterTable
ALTER TABLE "forum_threads" ADD COLUMN     "scope" VARCHAR(30) NOT NULL DEFAULT 'platform';

DELETE FROM "forum_categories" WHERE "slug" IN ('announcements', 'help', 'showcase');
