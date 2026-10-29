-- CreateTable
CREATE TABLE "image_scans" (
    "id" UUID NOT NULL,
    "image" VARCHAR(500) NOT NULL,
    "scanner" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "job_name" VARCHAR(100),
    "token_hash" VARCHAR(64),
    "digest" VARCHAR(100),
    "report" JSONB,
    "error" VARCHAR(1000),
    "requested_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    CONSTRAINT "image_scans_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "idx_image_scans_image_created" ON "image_scans"("image", "created_at" DESC);
-- CreateIndex
CREATE INDEX "idx_image_scans_status" ON "image_scans"("status");
