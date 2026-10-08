-- AlterTable
ALTER TABLE "sandbox_conversations" ADD COLUMN "preview_environment_id" UUID;

-- CreateTable
CREATE TABLE "sandbox_project_links" (
    "id" UUID NOT NULL,
    "sandbox_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sandbox_project_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_sandbox_project_links_sandbox_project" ON "sandbox_project_links"("sandbox_id", "project_id");

-- CreateIndex
CREATE INDEX "idx_sandbox_project_links_environment" ON "sandbox_project_links"("environment_id");

-- CreateIndex
CREATE INDEX "idx_sandbox_project_links_project" ON "sandbox_project_links"("project_id");

-- AddForeignKey
ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
