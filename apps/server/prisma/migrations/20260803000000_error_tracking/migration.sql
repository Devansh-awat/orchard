-- CreateTable
CREATE TABLE "error_groups" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "type" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'unresolved',
    "assignee_id" UUID,
    "github_issue_url" VARCHAR(500),
    "github_issue_number" INTEGER,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(6) NOT NULL,
    "last_seen_at" TIMESTAMP(6) NOT NULL,
    "first_image_history_id" UUID,
    "resolved_at" TIMESTAMP(6),
    "resolved_by_id" UUID,
    "sample_stack" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "error_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_occurrences" (
    "id" UUID NOT NULL,
    "error_group_id" UUID NOT NULL,
    "image_history_id" UUID,
    "count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(6) NOT NULL,
    "last_seen_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "error_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_error_group_deployment_status" ON "error_groups"("deployment_id", "status");

-- CreateIndex
CREATE INDEX "idx_error_group_deployment_last_seen" ON "error_groups"("deployment_id", "last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_error_group_deployment_fingerprint" ON "error_groups"("deployment_id", "fingerprint");

-- CreateIndex
CREATE INDEX "idx_error_occurrence_group" ON "error_occurrences"("error_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_error_occurrence_group_image" ON "error_occurrences"("error_group_id", "image_history_id");

-- AddForeignKey
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_first_image_history_id_fkey" FOREIGN KEY ("first_image_history_id") REFERENCES "image_history"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_occurrences" ADD CONSTRAINT "error_occurrences_error_group_id_fkey" FOREIGN KEY ("error_group_id") REFERENCES "error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_occurrences" ADD CONSTRAINT "error_occurrences_image_history_id_fkey" FOREIGN KEY ("image_history_id") REFERENCES "image_history"("id") ON DELETE SET NULL ON UPDATE CASCADE;
