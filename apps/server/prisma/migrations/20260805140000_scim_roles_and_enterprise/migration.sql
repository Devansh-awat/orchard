-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "scim_enterprise" JSONB;

-- AlterTable
ALTER TABLE "scim_deprovisioned_members" ADD COLUMN     "enterprise" JSONB;
