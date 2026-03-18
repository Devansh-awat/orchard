-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(255),
    "version" VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    "category" VARCHAR(100),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "yaml" TEXT NOT NULL,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "parameters" JSON NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'deploying',
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "template_instances_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Add template_instance_id to deployments
ALTER TABLE "deployments" ADD COLUMN "template_instance_id" UUID;

-- AlterTable: Add template_instance_id to databases
ALTER TABLE "databases" ADD COLUMN "template_instance_id" UUID;

-- AlterTable: Add template_instance_id to ingresses
ALTER TABLE "ingresses" ADD COLUMN "template_instance_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "templates_name_key" ON "templates"("name");

-- CreateIndex
CREATE INDEX "idx_templates_category" ON "templates"("category");

-- CreateIndex
CREATE INDEX "idx_templates_built_in" ON "templates"("is_built_in");

-- CreateIndex
CREATE INDEX "idx_template_instances_project" ON "template_instances"("project_id");

-- CreateIndex
CREATE INDEX "idx_template_instances_template" ON "template_instances"("template_id");

-- CreateIndex
CREATE INDEX "idx_deployments_template_instance" ON "deployments"("template_instance_id");

-- CreateIndex
CREATE INDEX "idx_databases_template_instance" ON "databases"("template_instance_id");

-- CreateIndex
CREATE INDEX "idx_ingresses_template_instance" ON "ingresses"("template_instance_id");

-- AddForeignKey
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_template_instance_id_fkey" FOREIGN KEY ("template_instance_id") REFERENCES "template_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_template_instance_id_fkey" FOREIGN KEY ("template_instance_id") REFERENCES "template_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_template_instance_id_fkey" FOREIGN KEY ("template_instance_id") REFERENCES "template_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
