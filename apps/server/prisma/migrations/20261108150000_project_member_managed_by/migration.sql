-- AlterTable
ALTER TABLE "project_members" ADD COLUMN     "managed_by_provider_id" UUID;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_managed_by_provider_id_fkey" FOREIGN KEY ("managed_by_provider_id") REFERENCES "identity_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

