-- CreateEnum
CREATE TYPE "organization_role" AS ENUM ('owner', 'admin', 'member', 'guest');

-- CreateEnum
CREATE TYPE "service_type" AS ENUM ('internal', 'external', 'ingress');

-- CreateEnum
CREATE TYPE "volume_type" AS ENUM ('pvc', 'hostPath', 'emptyDir');

-- CreateEnum
CREATE TYPE "build_type" AS ENUM ('dockerfile', 'railpack');

-- CreateEnum
CREATE TYPE "NodeAssignmentMode" AS ENUM ('allow', 'deny');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "hackclub_id" VARCHAR(255),
    "email" VARCHAR(255) NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255),
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "image_url" VARCHAR(500),
    "github_id" VARCHAR(255),
    "github_username" VARCHAR(255),
    "github_access_token" TEXT,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "setup_completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tailscale_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "tailnet" VARCHAR(255) NOT NULL,
    "tailscale_user_id" VARCHAR(255),
    "display_name" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "tailscale_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "last_used_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "device_name" VARCHAR(255),
    "location" VARCHAR(255),
    "auth_method" VARCHAR(20),
    "last_active_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_app_installations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" BIGINT NOT NULL,
    "account_login" VARCHAR(255) NOT NULL,
    "account_id" BIGINT NOT NULL,
    "account_type" VARCHAR(50) NOT NULL,
    "access_token" TEXT,
    "token_expires_at" TIMESTAMP(6),
    "repository_selection" VARCHAR(50) NOT NULL DEFAULT 'all',
    "suspended_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "github_app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_records" (
    "id" UUID NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "window_start" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_until" TIMESTAMP(6),

    CONSTRAINT "rate_limit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "device_type" VARCHAR(32) NOT NULL,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aaguid" VARCHAR(36),
    "friendly_name" VARCHAR(255),
    "last_used_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_challenges" (
    "id" UUID NOT NULL,
    "challenge" TEXT NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "user_id" UUID,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "avatar_url" VARCHAR(500),
    "plan" VARCHAR(50),
    "subdomain" VARCHAR(100),
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    "backup_r2_endpoint" VARCHAR(500),
    "backup_r2_bucket" VARCHAR(255),
    "backup_r2_region" VARCHAR(100),
    "backup_r2_access_key" VARCHAR(255),
    "backup_r2_secret_key" VARCHAR(500),
    "database_public_ip" VARCHAR(45),
    "cpu_limit_milli" INTEGER,
    "memory_limit_bytes" BIGINT,
    "max_pods" INTEGER,
    "max_services" INTEGER,
    "default_pod_cpu_milli" INTEGER,
    "default_pod_memory_bytes" BIGINT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "organization_role" NOT NULL DEFAULT 'member',
    "added_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by" UUID,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" "organization_role" NOT NULL DEFAULT 'member',
    "token" VARCHAR(255) NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "repository_url" VARCHAR(500),
    "icon" VARCHAR(500),
    "background_image" VARCHAR(1000),
    "namespace" VARCHAR(100) NOT NULL,
    "cpu_limit_milli" INTEGER,
    "memory_limit_bytes" BIGINT,
    "max_pods" INTEGER,
    "max_services" INTEGER,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "added_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by" UUID,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_invitations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "namespace" VARCHAR(100) NOT NULL,
    "image" VARCHAR(500),
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "cpu_request_milli" INTEGER,
    "memory_request_bytes" BIGINT,
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "build_status" VARCHAR(50) NOT NULL DEFAULT 'none',
    "build_step" VARCHAR(50),
    "build_type" "build_type" NOT NULL DEFAULT 'dockerfile',
    "github_repo" VARCHAR(500),
    "github_branch" VARCHAR(255),
    "dockerfile_path" VARCHAR(500),
    "build_from_root" BOOLEAN NOT NULL DEFAULT false,
    "build_with_depot" BOOLEAN NOT NULL DEFAULT false,
    "build_logs" TEXT,
    "build_error" TEXT,
    "build_step_timestamps" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    "tailscale_exposed" BOOLEAN NOT NULL DEFAULT false,
    "tailscale_hostname" VARCHAR(255),
    "tailscale_exposed_by" UUID,
    "auto_deploy_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_deploy_branch" VARCHAR(255),
    "health_check_enabled" BOOLEAN NOT NULL DEFAULT false,
    "health_check_path" VARCHAR(500),
    "health_check_port" INTEGER,
    "health_check_type" VARCHAR(20) NOT NULL DEFAULT 'http',
    "health_check_command" VARCHAR(500),
    "liveness_enabled" BOOLEAN NOT NULL DEFAULT true,
    "readiness_enabled" BOOLEAN NOT NULL DEFAULT true,
    "startup_enabled" BOOLEAN NOT NULL DEFAULT false,
    "health_check_interval" INTEGER NOT NULL DEFAULT 30,
    "health_check_timeout" INTEGER NOT NULL DEFAULT 5,
    "health_check_retries" INTEGER NOT NULL DEFAULT 3,
    "startup_failure_threshold" INTEGER NOT NULL DEFAULT 30,
    "template_instance_id" UUID,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_deployments" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "github_deployment_id" BIGINT NOT NULL,
    "owner" VARCHAR(255) NOT NULL,
    "repo" VARCHAR(255) NOT NULL,
    "ref" VARCHAR(255) NOT NULL,
    "commit_sha" VARCHAR(100) NOT NULL,
    "environment" VARCHAR(100) NOT NULL DEFAULT 'production',
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "log_url" VARCHAR(500),
    "environment_url" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "github_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_history" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "image" VARCHAR(500) NOT NULL,
    "tag" VARCHAR(100) NOT NULL,
    "commit_sha" VARCHAR(100),
    "commit_message" VARCHAR(500),
    "commit_author_name" VARCHAR(255),
    "commit_author_username" VARCHAR(255),
    "branch" VARCHAR(255),
    "build_logs" TEXT,
    "build_started_at" TIMESTAMP(6),
    "build_completed_at" TIMESTAMP(6),
    "trigger_type" VARCHAR(20),
    "triggered_by_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_webhook_tokens" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "label" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(6),

    CONSTRAINT "deployment_webhook_tokens_pkey" PRIMARY KEY ("id")
);

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
    "node_port" INTEGER,
    "domain" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

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
    "tls_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ingress_class" VARCHAR(100),
    "entrypoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cluster_issuer" VARCHAR(255),
    "annotations" JSON,
    "status_address" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    "template_instance_id" UUID,

    CONSTRAINT "ingresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ports" (
    "id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "name" VARCHAR(63),
    "port" INTEGER NOT NULL,
    "target_port" INTEGER NOT NULL,
    "protocol" VARCHAR(10) NOT NULL DEFAULT 'TCP',
    "node_port" INTEGER,
    "public_enabled" BOOLEAN NOT NULL DEFAULT false,
    "public_port" INTEGER,

    CONSTRAINT "service_ports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_volumes" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "volume_type" NOT NULL,
    "mount_path" VARCHAR(500) NOT NULL,
    "pvc_name" VARCHAR(255),
    "storage_size" VARCHAR(20),
    "host_path" VARCHAR(500),
    "read_only" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "deployment_volumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "databases" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "db_name" VARCHAR(63) NOT NULL,
    "db_user" VARCHAR(63) NOT NULL,
    "db_password" VARCHAR(255) NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "host" VARCHAR(255) NOT NULL DEFAULT 'postgresql-cluster-rw.postgresql.svc.cluster.local',
    "port" INTEGER NOT NULL DEFAULT 5432,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'shared',
    "namespace" VARCHAR(100),
    "container_name" VARCHAR(100),
    "storage_size" VARCHAR(20),
    "cluster_name" VARCHAR(100),
    "pg_parameters" JSONB,
    "shared_preload_libs" JSONB,
    "installed_extensions" JSONB,
    "backup_schedule_cron" VARCHAR(100),
    "public_enabled" BOOLEAN NOT NULL DEFAULT false,
    "public_ip" VARCHAR(45),
    "public_port" INTEGER,
    "cpu_request_milli" INTEGER,
    "memory_request_bytes" BIGINT,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    "template_instance_id" UUID,

    CONSTRAINT "databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_backups" (
    "id" UUID NOT NULL,
    "database_id" UUID NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "backup_name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(20) NOT NULL DEFAULT 'full',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "size_bytes" BIGINT,
    "error_message" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(6),

    CONSTRAINT "database_backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
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
    "id" UUID NOT NULL,
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

-- CreateTable
CREATE TABLE "sso_configs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" VARCHAR(10) NOT NULL,
    "oidc_issuer_url" VARCHAR(500),
    "oidc_client_id" VARCHAR(255),
    "oidc_client_secret" TEXT,
    "oidc_scopes" VARCHAR(500),
    "saml_entry_point" VARCHAR(500),
    "saml_issuer" VARCHAR(500),
    "saml_certificate" TEXT,
    "saml_metadata_url" VARCHAR(500),
    "login_logo_url" VARCHAR(500),
    "login_primary_color" VARCHAR(7),
    "login_bg_color" VARCHAR(7),
    "login_welcome_text" VARCHAR(500),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sso_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" VARCHAR(80) NOT NULL,
    "actor_user_id" UUID,
    "actor_email" VARCHAR(255),
    "organization_id" UUID,
    "project_id" UUID,
    "deployment_id" UUID,
    "target_type" VARCHAR(40),
    "target_id" VARCHAR(64),
    "target_label" VARCHAR(255),
    "metadata" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

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
CREATE UNIQUE INDEX "users_hackclub_id_key" ON "users"("hackclub_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "tailscale_connections_user_id_key" ON "tailscale_connections"("user_id");

-- CreateIndex
CREATE INDEX "idx_tailscale_connections_user" ON "tailscale_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_key" ON "api_tokens"("token");

-- CreateIndex
CREATE INDEX "idx_api_tokens_user" ON "api_tokens"("user_id");

-- CreateIndex
CREATE INDEX "idx_api_tokens_token" ON "api_tokens"("token");

-- CreateIndex
CREATE INDEX "idx_sessions_user" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "idx_sessions_expires" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "github_app_installations_installation_id_key" ON "github_app_installations"("installation_id");

-- CreateIndex
CREATE INDEX "idx_github_app_installations_user" ON "github_app_installations"("user_id");

-- CreateIndex
CREATE INDEX "idx_github_app_installations_account" ON "github_app_installations"("account_login");

-- CreateIndex
CREATE INDEX "idx_otp_codes_email" ON "otp_codes"("email");

-- CreateIndex
CREATE INDEX "idx_otp_codes_expires" ON "otp_codes"("expires_at");

-- CreateIndex
CREATE INDEX "idx_rate_limit_lookup" ON "rate_limit_records"("identifier", "type", "action");

-- CreateIndex
CREATE INDEX "idx_rate_limit_window" ON "rate_limit_records"("window_start");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_records_identifier_type_action_key" ON "rate_limit_records"("identifier", "type", "action");

-- CreateIndex
CREATE UNIQUE INDEX "passkeys_credential_id_key" ON "passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "idx_passkeys_user" ON "passkeys"("user_id");

-- CreateIndex
CREATE INDEX "idx_passkeys_credential" ON "passkeys"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_challenges_challenge_key" ON "webauthn_challenges"("challenge");

-- CreateIndex
CREATE INDEX "idx_webauthn_challenges_challenge" ON "webauthn_challenges"("challenge");

-- CreateIndex
CREATE INDEX "idx_webauthn_challenges_expires" ON "webauthn_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_subdomain_key" ON "organizations"("subdomain");

-- CreateIndex
CREATE INDEX "idx_organization_members_org" ON "organization_members"("organization_id");

-- CreateIndex
CREATE INDEX "idx_organization_members_user" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_key" ON "organization_invitations"("token");

-- CreateIndex
CREATE INDEX "idx_organization_invitations_org" ON "organization_invitations"("organization_id");

-- CreateIndex
CREATE INDEX "idx_organization_invitations_email" ON "organization_invitations"("email");

-- CreateIndex
CREATE INDEX "idx_organization_invitations_token" ON "organization_invitations"("token");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_organization_id_email_key" ON "organization_invitations"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "idx_projects_organization" ON "projects"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "idx_project_members_project" ON "project_members"("project_id");

-- CreateIndex
CREATE INDEX "idx_project_members_user" ON "project_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_project_invitations_project" ON "project_invitations"("project_id");

-- CreateIndex
CREATE INDEX "idx_project_invitations_user" ON "project_invitations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_invitations_project_id_user_id_key" ON "project_invitations"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_deployments_project" ON "deployments"("project_id");

-- CreateIndex
CREATE INDEX "idx_deployments_template_instance" ON "deployments"("template_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_project_id_name_key" ON "deployments"("project_id", "name");

-- CreateIndex
CREATE INDEX "idx_github_deployments_deployment" ON "github_deployments"("deployment_id");

-- CreateIndex
CREATE INDEX "idx_github_deployments_repo" ON "github_deployments"("owner", "repo");

-- CreateIndex
CREATE UNIQUE INDEX "github_deployments_deployment_id_github_deployment_id_key" ON "github_deployments"("deployment_id", "github_deployment_id");

-- CreateIndex
CREATE INDEX "idx_image_history_deployment" ON "image_history"("deployment_id");

-- CreateIndex
CREATE INDEX "idx_image_history_deployment_date" ON "image_history"("deployment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_webhook_tokens_token_key" ON "deployment_webhook_tokens"("token");

-- CreateIndex
CREATE INDEX "idx_webhook_tokens_deployment" ON "deployment_webhook_tokens"("deployment_id");

-- CreateIndex
CREATE INDEX "idx_deployment_env_vars_deployment" ON "deployment_env_vars"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_env_vars_deployment_id_key_key" ON "deployment_env_vars"("deployment_id", "key");

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

-- CreateIndex
CREATE INDEX "idx_ingresses_project" ON "ingresses"("project_id");

-- CreateIndex
CREATE INDEX "idx_ingresses_deployment" ON "ingresses"("deployment_id");

-- CreateIndex
CREATE INDEX "idx_ingresses_service" ON "ingresses"("service_id");

-- CreateIndex
CREATE INDEX "idx_ingresses_template_instance" ON "ingresses"("template_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingresses_namespace_name_key" ON "ingresses"("namespace", "name");

-- CreateIndex
CREATE INDEX "idx_service_ports_service" ON "service_ports"("service_id");

-- CreateIndex
CREATE INDEX "idx_deployment_volumes_deployment" ON "deployment_volumes"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_volumes_deployment_id_name_key" ON "deployment_volumes"("deployment_id", "name");

-- CreateIndex
CREATE INDEX "idx_databases_project" ON "databases"("project_id");

-- CreateIndex
CREATE INDEX "idx_databases_template_instance" ON "databases"("template_instance_id");

-- CreateIndex
CREATE INDEX "idx_databases_public_endpoint" ON "databases"("public_ip", "public_port");

-- CreateIndex
CREATE UNIQUE INDEX "databases_project_id_name_key" ON "databases"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "databases_db_name_key" ON "databases"("db_name");

-- CreateIndex
CREATE INDEX "idx_database_backups_lookup" ON "database_backups"("database_id", "created_at");

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
CREATE UNIQUE INDEX "sso_configs_organization_id_key" ON "sso_configs"("organization_id");

-- CreateIndex
CREATE INDEX "idx_sso_config_org" ON "sso_configs"("organization_id");

-- CreateIndex
CREATE INDEX "idx_audit_logs_created" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_logs_org" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_logs_project" ON "audit_logs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_logs_deployment" ON "audit_logs"("deployment_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_logs_actor" ON "audit_logs"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "nodes_name_key" ON "nodes"("name");

-- CreateIndex
CREATE INDEX "idx_org_node_assignments_node" ON "org_node_assignments"("node_id");

-- CreateIndex
CREATE INDEX "idx_org_node_assignments_org" ON "org_node_assignments"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_node_assignments_organization_id_node_id_key" ON "org_node_assignments"("organization_id", "node_id");

-- AddForeignKey
ALTER TABLE "tailscale_connections" ADD CONSTRAINT "tailscale_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_template_instance_id_fkey" FOREIGN KEY ("template_instance_id") REFERENCES "template_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_deployments" ADD CONSTRAINT "github_deployments_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_history" ADD CONSTRAINT "image_history_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_history" ADD CONSTRAINT "image_history_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_webhook_tokens" ADD CONSTRAINT "deployment_webhook_tokens_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_env_vars" ADD CONSTRAINT "deployment_env_vars_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pods" ADD CONSTRAINT "pods_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_template_instance_id_fkey" FOREIGN KEY ("template_instance_id") REFERENCES "template_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ports" ADD CONSTRAINT "service_ports_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_volumes" ADD CONSTRAINT "deployment_volumes_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_template_instance_id_fkey" FOREIGN KEY ("template_instance_id") REFERENCES "template_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_database_id_fkey" FOREIGN KEY ("database_id") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_configs" ADD CONSTRAINT "sso_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

