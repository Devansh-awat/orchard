-- CreateTable
CREATE TABLE "user_context_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "payload" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lock" VARCHAR(16) NOT NULL DEFAULT 'server',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "user_context_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_context_items_user_id_kind_name_key" ON "user_context_items"("user_id", "kind", "name");

-- AddForeignKey
ALTER TABLE "user_context_items" ADD CONSTRAINT "user_context_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

