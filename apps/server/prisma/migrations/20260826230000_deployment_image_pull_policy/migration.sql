-- CreateEnum
CREATE TYPE "image_pull_policy_kind" AS ENUM ('Always', 'IfNotPresent');

-- AlterTable
-- Nullable on purpose: NULL means "derive it from the image tag", a concrete
-- value means the user overrode that. See kubernetes/trusted-images.ts.
ALTER TABLE "deployments" ADD COLUMN "image_pull_policy" "image_pull_policy_kind";
