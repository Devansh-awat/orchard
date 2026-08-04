-- AlterTable
ALTER TABLE "sandboxes" DROP COLUMN "ssh_public_keys",
ADD COLUMN     "chat_session_id" VARCHAR(255),
ADD COLUMN     "ssh_identity_id" UUID;

-- CreateTable
CREATE TABLE "ssh_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "public_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "ssh_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ssh_identities_user_id_name_key" ON "ssh_identities"("user_id", "name");

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_ssh_identity_id_fkey" FOREIGN KEY ("ssh_identity_id") REFERENCES "ssh_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ssh_identities" ADD CONSTRAINT "ssh_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

