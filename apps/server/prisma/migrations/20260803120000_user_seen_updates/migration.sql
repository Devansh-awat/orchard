-- AlterTable
ALTER TABLE "users" ADD COLUMN     "seen_updates" TEXT[] DEFAULT ARRAY[]::TEXT[];
