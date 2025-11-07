-- CreateTable
CREATE TABLE "ingresses" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "deployment_id" UUID,
    "service_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "namespace" VARCHAR(100) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "path" VARCHAR(255) NOT NULL DEFAULT '/',
    "path_type" VARCHAR(32) NOT NULL DEFAULT 'Prefix',
    "tls_secret_name" VARCHAR(255),
    "tls_hosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ingress_class" VARCHAR(100),
    "entrypoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cluster_issuer" VARCHAR(255),
    "annotations" JSONB,
    "status_address" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingresses_namespace_name_key" ON "ingresses"("namespace", "name");

-- CreateIndex
CREATE INDEX "idx_ingresses_project" ON "ingresses"("project_id");

-- CreateIndex
CREATE INDEX "idx_ingresses_deployment" ON "ingresses"("deployment_id");

-- CreateIndex
CREATE INDEX "idx_ingresses_service" ON "ingresses"("service_id");

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

