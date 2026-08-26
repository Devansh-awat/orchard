-- CreateEnum
CREATE TYPE "image_pull_policy_kind" AS ENUM ('Always', 'IfNotPresent');

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "image_pull_policy" "image_pull_policy_kind" NOT NULL DEFAULT 'IfNotPresent';
