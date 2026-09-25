-- CreateTable
CREATE TABLE "resource_bindings" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "resource_type" VARCHAR(20) NOT NULL,
    "resource_id" UUID NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_resource_bindings_resource" ON "resource_bindings"("resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_bindings_deployment_id_name_key" ON "resource_bindings"("deployment_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "resource_bindings_deployment_id_resource_type_resource_id_key" ON "resource_bindings"("deployment_id", "resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "resource_bindings" ADD CONSTRAINT "resource_bindings_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

