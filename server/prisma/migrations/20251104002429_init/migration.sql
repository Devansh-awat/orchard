-- CreateEnum
CREATE TYPE "service_type" AS ENUM ('internal', 'external', 'ingress');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "added_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by" UUID,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "repository_url" VARCHAR(500),
    "namespace" VARCHAR(100) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "namespace" VARCHAR(100) NOT NULL,
    "image" VARCHAR(500),
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pods" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "pod_ip" VARCHAR(45),
    "node_name" VARCHAR(255),
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "restart_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "pods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "service_type" NOT NULL,
    "port" INTEGER NOT NULL,
    "target_port" INTEGER NOT NULL,
    "protocol" VARCHAR(10) NOT NULL DEFAULT 'TCP',
    "external_ip" VARCHAR(45),
    "domain" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "idx_workspace_members_workspace" ON "workspace_members"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_workspace_members_user" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_role_id_key" ON "workspace_members"("workspace_id", "user_id", "role_id");

-- CreateIndex
CREATE INDEX "idx_projects_workspace" ON "projects"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_slug_key" ON "projects"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "idx_deployments_project" ON "deployments"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_project_id_name_key" ON "deployments"("project_id", "name");

-- CreateIndex
CREATE INDEX "idx_pods_deployment" ON "pods"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "pods_deployment_id_name_key" ON "pods"("deployment_id", "name");

-- CreateIndex
CREATE INDEX "idx_services_deployment" ON "services"("deployment_id");

-- CreateIndex
CREATE INDEX "idx_services_type" ON "services"("type");

-- CreateIndex
CREATE UNIQUE INDEX "services_deployment_id_name_key" ON "services"("deployment_id", "name");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pods" ADD CONSTRAINT "pods_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
