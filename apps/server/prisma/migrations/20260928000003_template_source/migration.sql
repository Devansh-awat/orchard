-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "source" VARCHAR(20) NOT NULL DEFAULT 'custom';

UPDATE "templates" SET "source" = 'built-in' WHERE "is_built_in";
