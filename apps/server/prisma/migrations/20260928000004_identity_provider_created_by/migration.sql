-- AlterTable
ALTER TABLE "identity_providers" ADD COLUMN     "created_by" UUID;

UPDATE "identity_providers" p
SET "created_by" = COALESCE(
  (SELECT o."created_by" FROM "organizations" o
     JOIN "organization_members" m ON m."organization_id" = o."id" AND m."user_id" = o."created_by" AND m."role" = 'owner'
    WHERE o."id" = p."organization_id"),
  (SELECT m."user_id" FROM "organization_members" m
    WHERE m."organization_id" = p."organization_id" AND m."role" = 'owner'
    ORDER BY m."user_id" LIMIT 1)
)
WHERE p."created_by" IS NULL AND p."organization_id" IS NOT NULL;
