-- AlterTable
ALTER TABLE "image_history" ADD COLUMN "trigger_type" VARCHAR(20),
ADD COLUMN "triggered_by_id" UUID;

-- AddForeignKey
ALTER TABLE "image_history" ADD CONSTRAINT "image_history_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
