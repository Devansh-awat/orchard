-- CreateEnum
CREATE TYPE "NodePoolAffinityMode" AS ENUM ('required', 'preferred');

-- AlterTable
ALTER TABLE "databases" ADD COLUMN     "node_pool_id" UUID,
ADD COLUMN     "placement_override" JSONB;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "node_pool_id" UUID,
ADD COLUMN     "placement_override" JSONB;

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "node_pool_id" UUID,
ADD COLUMN     "placement_override" JSONB;

-- AlterTable
ALTER TABLE "nodes" ADD COLUMN     "taints" JSONB;

-- CreateTable
CREATE TABLE "node_pools" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "nodeSelector" JSONB NOT NULL DEFAULT '[]',
    "tolerations" JSONB NOT NULL DEFAULT '[]',
    "affinityMode" "NodePoolAffinityMode" NOT NULL DEFAULT 'preferred',
    "user_selectable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "node_pools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "node_pools_slug_key" ON "node_pools"("slug");

-- CreateIndex
CREATE INDEX "idx_databases_node_pool" ON "databases"("node_pool_id");

-- CreateIndex
CREATE INDEX "idx_deployments_node_pool" ON "deployments"("node_pool_id");

-- CreateIndex
CREATE INDEX "idx_jobs_node_pool" ON "jobs"("node_pool_id");

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_node_pool_id_fkey" FOREIGN KEY ("node_pool_id") REFERENCES "node_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_node_pool_id_fkey" FOREIGN KEY ("node_pool_id") REFERENCES "node_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_node_pool_id_fkey" FOREIGN KEY ("node_pool_id") REFERENCES "node_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

