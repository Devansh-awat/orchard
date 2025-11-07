-- CreateTable
CREATE TABLE "deployment_env_vars" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "deployment_env_vars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_deployment_env_vars_deployment" ON "deployment_env_vars"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_env_vars_deployment_id_key_key" ON "deployment_env_vars"("deployment_id", "key");

-- AddForeignKey
ALTER TABLE "deployment_env_vars" ADD CONSTRAINT "deployment_env_vars_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

