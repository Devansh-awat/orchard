-- CreateTable
CREATE TABLE "k8s_objects" (
    "uid" VARCHAR(64) NOT NULL,
    "api_version" VARCHAR(100) NOT NULL,
    "kind" VARCHAR(60) NOT NULL,
    "namespace" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "resource_version" VARCHAR(30) NOT NULL,
    "shard" VARCHAR(40) NOT NULL,
    "manifest" JSONB NOT NULL,
    "deployment_id" UUID,
    "project_id" UUID,
    "database_id" UUID,
    "job_id" UUID,
    "synced_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "k8s_objects_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "k8s_mirror_heartbeats" (
    "shard" VARCHAR(40) NOT NULL,
    "holder" VARCHAR(120),
    "last_list_at" TIMESTAMP(6),
    "last_event_at" TIMESTAMP(6),
    "last_resync_at" TIMESTAMP(6),
    "resync_repairs" INTEGER NOT NULL DEFAULT 0,
    "resource_version" VARCHAR(30),
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "k8s_mirror_heartbeats_pkey" PRIMARY KEY ("shard")
);

-- CreateTable
CREATE TABLE "pod_transitions" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "pod_name" VARCHAR(255) NOT NULL,
    "from_status" VARCHAR(50),
    "to_status" VARCHAR(50) NOT NULL,
    "reason" VARCHAR(100),
    "exit_code" INTEGER,
    "at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "k8s_workloads" (
    "deployment_id" UUID NOT NULL,
    "spec_replicas" INTEGER,
    "ready_replicas" INTEGER NOT NULL DEFAULT 0,
    "available_replicas" INTEGER NOT NULL DEFAULT 0,
    "updated_replicas" INTEGER NOT NULL DEFAULT 0,
    "observed_image" VARCHAR(500),
    "conditions" JSONB,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "k8s_workloads_pkey" PRIMARY KEY ("deployment_id")
);

-- CreateIndex
CREATE INDEX "idx_k8s_objects_shard" ON "k8s_objects"("shard");

-- CreateIndex
CREATE INDEX "idx_k8s_objects_kind_namespace" ON "k8s_objects"("kind", "namespace");

-- CreateIndex
CREATE INDEX "idx_k8s_objects_deployment" ON "k8s_objects"("deployment_id");

-- CreateIndex
CREATE INDEX "idx_k8s_objects_project" ON "k8s_objects"("project_id");

-- CreateIndex
CREATE INDEX "idx_k8s_objects_database" ON "k8s_objects"("database_id");

-- CreateIndex
CREATE UNIQUE INDEX "k8s_objects_kind_namespace_name_api_version_key" ON "k8s_objects"("kind", "namespace", "name", "api_version");

-- CreateIndex
CREATE INDEX "idx_pod_transitions_deployment_at" ON "pod_transitions"("deployment_id", "at" DESC);

