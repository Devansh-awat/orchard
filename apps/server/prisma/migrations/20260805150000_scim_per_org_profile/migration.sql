-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "scim_user_name" VARCHAR(255),
ADD COLUMN     "scim_given_name" VARCHAR(255),
ADD COLUMN     "scim_family_name" VARCHAR(255),
ADD COLUMN     "scim_display_name" VARCHAR(255);

-- AlterTable
ALTER TABLE "scim_deprovisioned_members" ADD COLUMN     "user_name" VARCHAR(255),
ADD COLUMN     "given_name" VARCHAR(255),
ADD COLUMN     "family_name" VARCHAR(255),
ADD COLUMN     "display_name" VARCHAR(255);

-- Seed the per-org profile from the shared account for memberships SCIM already
-- owns, so already-provisioned users keep the identity their IdP knows them by.
UPDATE "organization_members" m
SET "scim_user_name" = u."email",
    "scim_given_name" = u."first_name",
    "scim_family_name" = u."last_name"
FROM "users" u
WHERE u."id" = m."user_id" AND m."scim_managed" = true;
