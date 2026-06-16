-- CreateTable
CREATE TABLE "compose_stacks" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "compose_yaml" TEXT NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'deploying',
    "last_error" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "compose_stacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compose_stacks_project_id_name_key" ON "compose_stacks"("project_id", "name");

-- CreateIndex
CREATE INDEX "idx_compose_stacks_project" ON "compose_stacks"("project_id");

-- AddForeignKey
ALTER TABLE "compose_stacks" ADD CONSTRAINT "compose_stacks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compose_stacks" ADD CONSTRAINT "compose_stacks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "compose_stack_id" UUID,
                          ADD COLUMN "compose_service_name" VARCHAR(255);

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_compose_stack_id_fkey" FOREIGN KEY ("compose_stack_id") REFERENCES "compose_stacks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "idx_deployments_compose_stack" ON "deployments"("compose_stack_id");
