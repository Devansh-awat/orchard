-- CreateEnum
CREATE TYPE "NodeAssignmentMode" AS ENUM ('allow', 'deny');

-- CreateTable
CREATE TABLE "nodes" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "labels" JSONB,
    "schedulable" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "cpu_capacity" VARCHAR(32),
    "memory_capacity" VARCHAR(32),
    "last_seen_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nodes_name_key" ON "nodes"("name");

-- CreateTable
CREATE TABLE "org_node_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "mode" "NodeAssignmentMode" NOT NULL DEFAULT 'allow',
    "cpu_limit" VARCHAR(32),
    "memory_limit" VARCHAR(32),
    "max_services" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "org_node_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_node_assignments_organization_id_node_id_key" ON "org_node_assignments"("organization_id", "node_id");
CREATE INDEX "idx_org_node_assignments_node" ON "org_node_assignments"("node_id");
CREATE INDEX "idx_org_node_assignments_org" ON "org_node_assignments"("organization_id");

-- AddForeignKey
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
