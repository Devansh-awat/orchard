-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "organization_id" UUID;

-- CreateIndex
CREATE INDEX "idx_sandboxes_organization" ON "sandboxes"("organization_id");

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: attach existing sandboxes to their owner's oldest organization.
UPDATE "sandboxes" s
SET "organization_id" = (
  SELECT m."organization_id"
  FROM "organization_members" m
  WHERE m."user_id" = s."user_id"
  ORDER BY m."added_at" ASC
  LIMIT 1
)
WHERE s."organization_id" IS NULL;
