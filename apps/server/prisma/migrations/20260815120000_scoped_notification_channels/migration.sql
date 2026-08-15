-- AlterTable
ALTER TABLE "notification_channels" ADD COLUMN     "created_by" UUID,
ADD COLUMN     "scope_id" UUID,
ADD COLUMN     "scope_type" VARCHAR(20) NOT NULL DEFAULT 'org';

-- CreateIndex
CREATE INDEX "idx_notification_channels_scope" ON "notification_channels"("organization_id", "scope_type", "scope_id");

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

