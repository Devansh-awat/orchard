-- CreateTable
CREATE TABLE "instance_settings" (
    "key" VARCHAR(191) NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "instance_settings_pkey" PRIMARY KEY ("key")
);

