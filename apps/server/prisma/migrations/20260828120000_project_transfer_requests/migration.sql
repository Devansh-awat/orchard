-- CreateEnum
CREATE TYPE "project_transfer_status" AS ENUM ('pending', 'accepted', 'declined', 'canceled');

-- CreateTable
CREATE TABLE "project_transfer_requests" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "status" "project_transfer_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "responded_at" TIMESTAMP(6),

    CONSTRAINT "project_transfer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_project_transfers_project" ON "project_transfer_requests"("project_id");

-- CreateIndex
CREATE INDEX "idx_project_transfers_recipient" ON "project_transfer_requests"("to_user_id", "status");

-- AddForeignKey
ALTER TABLE "project_transfer_requests" ADD CONSTRAINT "project_transfer_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transfer_requests" ADD CONSTRAINT "project_transfer_requests_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_transfer_requests" ADD CONSTRAINT "project_transfer_requests_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one open request per project. Prisma can't express a partial unique
-- index, so it lives here: the service checks for an existing pending request
-- before inserting, and this is what makes two concurrent requests lose one
-- instead of leaving the project with two live offers.
CREATE UNIQUE INDEX "uniq_project_transfers_open" ON "project_transfer_requests"("project_id") WHERE "status" = 'pending';
