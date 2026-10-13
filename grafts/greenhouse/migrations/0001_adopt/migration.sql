DO $adopt$
DECLARE
  t text;
  tables text[] := ARRAY[
    'sandboxes',
    'sandbox_conversations',
    'ssh_identities',
    'sandbox_credentials',
    'sandbox_members',
    'sandbox_prompt_authors',
    'sandbox_session_messages',
    'sandbox_project_links',
    'sandbox_share_links',
    'user_integrations',
    'slack_link_tokens',
    'sandbox_integration_deliveries',
    'slack_thread_links',
    'user_context_items'
  ];
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.sandboxes')) = 'r' THEN
    FOREACH t IN ARRAY tables LOOP
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA ext_greenhouse', t);
    END LOOP;
  ELSIF to_regclass('ext_greenhouse.sandboxes') IS NULL THEN
    IF to_regtype('public."SandboxStatus"') IS NULL THEN
      CREATE TYPE public."SandboxStatus" AS ENUM ('creating', 'starting', 'running', 'stopping', 'stopped', 'deleting', 'error');
    END IF;
    IF to_regtype('public."SandboxRunnerKind"') IS NULL THEN
      CREATE TYPE public."SandboxRunnerKind" AS ENUM ('kubernetes', 'vercel');
    END IF;
    IF to_regtype('public."SandboxDesiredState"') IS NULL THEN
      CREATE TYPE public."SandboxDesiredState" AS ENUM ('running', 'stopped', 'deleted');
    END IF;
    IF to_regtype('public."SandboxMemberRole"') IS NULL THEN
      CREATE TYPE public."SandboxMemberRole" AS ENUM ('viewer', 'collaborator');
    END IF;
    EXECUTE $ddl$
      CREATE TABLE "sandboxes" (
          "id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "organization_id" UUID,
          "name" VARCHAR(63) NOT NULL,
          "status" "SandboxStatus" NOT NULL DEFAULT 'creating',
          "status_message" TEXT,
          "pod_name" VARCHAR(253) NOT NULL,
          "namespace" VARCHAR(253),
          "runner" "SandboxRunnerKind" NOT NULL DEFAULT 'kubernetes',
          "desired_state" "SandboxDesiredState" NOT NULL DEFAULT 'running',
          "external_id" VARCHAR(255),
          "runner_state" JSONB,
          "secret_epoch" INTEGER NOT NULL DEFAULT 0,
          "image" VARCHAR(500) NOT NULL,
          "repo_url" VARCHAR(500),
          "ssh_identity_id" UUID,
          "setup_script" TEXT,
          "cpu_limit" VARCHAR(20) NOT NULL,
          "memory_limit" VARCHAR(20) NOT NULL,
          "disk_size" VARCHAR(20) NOT NULL,
          "last_active_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "started_at" TIMESTAMP(6),
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_conversations" (
          "id" UUID NOT NULL,
          "sandbox_id" UUID NOT NULL,
          "title" VARCHAR(120) NOT NULL,
          "repo" VARCHAR(120),
          "claude_session_id" VARCHAR(255),
          "slug" VARCHAR(64),
          "branch" VARCHAR(255),
          "base_branch" VARCHAR(255),
          "base_commit" VARCHAR(64),
          "worktree_path" VARCHAR(500),
          "agent" VARCHAR(32) NOT NULL DEFAULT 'opencode',
          "opencode_session_id" VARCHAR(255),
          "pr_url" VARCHAR(500),
          "pr_number" INTEGER,
          "pr_state" VARCHAR(16),
          "preview_deployment_id" UUID,
          "preview_url" VARCHAR(500),
          "preview_environment_id" UUID,
          "created_by_id" UUID,
          "archived_at" TIMESTAMP(6),
          "prepare_error" TEXT,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "sandbox_conversations_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "ssh_identities" (
          "id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "name" VARCHAR(100) NOT NULL,
          "public_key" TEXT NOT NULL,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "ssh_identities_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_credentials" (
          "id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "claude_token" TEXT,
          "openai_token" TEXT,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "sandbox_credentials_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_members" (
          "id" UUID NOT NULL,
          "sandbox_id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "role" "SandboxMemberRole" NOT NULL,
          "invited_by_id" UUID,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "sandbox_members_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_prompt_authors" (
          "id" UUID NOT NULL,
          "sandbox_id" UUID NOT NULL,
          "session_id" UUID,
          "opencode_session_id" VARCHAR(64) NOT NULL,
          "message_id" VARCHAR(64) NOT NULL,
          "user_id" UUID NOT NULL,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "sandbox_prompt_authors_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_session_messages" (
          "id" UUID NOT NULL,
          "sandbox_id" UUID NOT NULL,
          "session_id" UUID NOT NULL,
          "chat_id" VARCHAR(64) NOT NULL,
          "user_id" UUID NOT NULL,
          "body" TEXT NOT NULL,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "sandbox_session_messages_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_project_links" (
          "id" UUID NOT NULL,
          "sandbox_id" UUID NOT NULL,
          "project_id" UUID NOT NULL,
          "environment_id" UUID NOT NULL,
          "created_by_id" UUID NOT NULL,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "sandbox_project_links_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_share_links" (
          "id" UUID NOT NULL,
          "sandbox_id" UUID NOT NULL,
          "session_id" UUID,
          "created_by_id" UUID NOT NULL,
          "token_hash" VARCHAR(64) NOT NULL,
          "expires_at" TIMESTAMP(6),
          "revoked_at" TIMESTAMP(6),
          "last_used_at" TIMESTAMP(6),
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "sandbox_share_links_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "user_integrations" (
          "id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "provider" VARCHAR(32) NOT NULL,
          "secret" TEXT,
          "external_id" VARCHAR(255),
          "workspace_name" VARCHAR(255),
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "user_integrations_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "slack_link_tokens" (
          "id" UUID NOT NULL,
          "token_hash" VARCHAR(64) NOT NULL,
          "team_id" VARCHAR(32) NOT NULL,
          "slack_user_id" VARCHAR(32) NOT NULL,
          "slack_user_name" VARCHAR(80),
          "team_domain" VARCHAR(80),
          "expires_at" TIMESTAMP(6) NOT NULL,
          "used_at" TIMESTAMP(6),
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "slack_link_tokens_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "sandbox_integration_deliveries" (
          "id" UUID NOT NULL,
          "provider" VARCHAR(32) NOT NULL,
          "delivery_id" VARCHAR(255) NOT NULL,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "sandbox_integration_deliveries_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "slack_thread_links" (
          "id" UUID NOT NULL,
          "session_id" UUID NOT NULL,
          "sandbox_id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "channel" VARCHAR(64) NOT NULL,
          "thread_ts" VARCHAR(64) NOT NULL,
          "saw_working" BOOLEAN NOT NULL DEFAULT false,
          "completed_at" TIMESTAMP(6),
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "slack_thread_links_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "user_context_items" (
          "id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "kind" VARCHAR(20) NOT NULL,
          "name" VARCHAR(64) NOT NULL,
          "payload" TEXT NOT NULL,
          "size_bytes" INTEGER NOT NULL,
          "enabled" BOOLEAN NOT NULL DEFAULT true,
          "lock" VARCHAR(16) NOT NULL DEFAULT 'server',
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) NOT NULL,

          CONSTRAINT "user_context_items_pkey" PRIMARY KEY ("id")
      );

      CREATE UNIQUE INDEX "sandboxes_pod_name_key" ON "sandboxes"("pod_name");

      CREATE INDEX "idx_sandboxes_status_active" ON "sandboxes"("status", "last_active_at");

      CREATE INDEX "idx_sandboxes_organization" ON "sandboxes"("organization_id");

      CREATE INDEX "idx_sandboxes_runner_status" ON "sandboxes"("runner", "status");

      CREATE UNIQUE INDEX "sandboxes_user_id_name_key" ON "sandboxes"("user_id", "name");

      CREATE INDEX "idx_sandbox_conversations_sandbox" ON "sandbox_conversations"("sandbox_id");

      CREATE INDEX "idx_sandbox_conversations_sandbox_archived" ON "sandbox_conversations"("sandbox_id", "archived_at");

      CREATE UNIQUE INDEX "uq_sandbox_conversations_sandbox_slug" ON "sandbox_conversations"("sandbox_id", "slug");

      CREATE UNIQUE INDEX "ssh_identities_user_id_name_key" ON "ssh_identities"("user_id", "name");

      CREATE UNIQUE INDEX "sandbox_credentials_user_id_key" ON "sandbox_credentials"("user_id");

      CREATE INDEX "idx_sandbox_members_user" ON "sandbox_members"("user_id");

      CREATE UNIQUE INDEX "uq_sandbox_members_sandbox_user" ON "sandbox_members"("sandbox_id", "user_id");

      CREATE INDEX "idx_sandbox_prompt_authors_chat" ON "sandbox_prompt_authors"("sandbox_id", "opencode_session_id");

      CREATE INDEX "idx_sandbox_prompt_authors_session" ON "sandbox_prompt_authors"("session_id");

      CREATE UNIQUE INDEX "uq_sandbox_prompt_authors_message" ON "sandbox_prompt_authors"("sandbox_id", "message_id");

      CREATE INDEX "idx_sandbox_session_messages_session" ON "sandbox_session_messages"("session_id", "created_at");

      CREATE INDEX "idx_sandbox_session_messages_sandbox" ON "sandbox_session_messages"("sandbox_id");

      CREATE INDEX "idx_sandbox_project_links_environment" ON "sandbox_project_links"("environment_id");

      CREATE INDEX "idx_sandbox_project_links_project" ON "sandbox_project_links"("project_id");

      CREATE UNIQUE INDEX "uq_sandbox_project_links_sandbox_project" ON "sandbox_project_links"("sandbox_id", "project_id");

      CREATE UNIQUE INDEX "uq_sandbox_share_links_token_hash" ON "sandbox_share_links"("token_hash");

      CREATE INDEX "idx_sandbox_share_links_sandbox" ON "sandbox_share_links"("sandbox_id");

      CREATE INDEX "idx_sandbox_share_links_session" ON "sandbox_share_links"("session_id");

      CREATE UNIQUE INDEX "uq_user_integrations_user_provider" ON "user_integrations"("user_id", "provider");

      CREATE UNIQUE INDEX "uq_user_integrations_provider_external" ON "user_integrations"("provider", "external_id");

      CREATE UNIQUE INDEX "uq_slack_link_tokens_hash" ON "slack_link_tokens"("token_hash");

      CREATE INDEX "idx_slack_link_tokens_identity" ON "slack_link_tokens"("team_id", "slack_user_id");

      CREATE INDEX "idx_slack_link_tokens_expires" ON "slack_link_tokens"("expires_at");

      CREATE INDEX "idx_sandbox_integration_deliveries_created" ON "sandbox_integration_deliveries"("created_at");

      CREATE UNIQUE INDEX "uq_sandbox_integration_deliveries" ON "sandbox_integration_deliveries"("provider", "delivery_id");

      CREATE INDEX "idx_slack_thread_links_pending" ON "slack_thread_links"("completed_at", "created_at");

      CREATE INDEX "idx_slack_thread_links_session" ON "slack_thread_links"("session_id");

      CREATE UNIQUE INDEX "user_context_items_user_id_kind_name_key" ON "user_context_items"("user_id", "kind", "name");

      ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_ssh_identity_id_fkey" FOREIGN KEY ("ssh_identity_id") REFERENCES "ssh_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

      ALTER TABLE "sandbox_conversations" ADD CONSTRAINT "sandbox_conversations_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_conversations" ADD CONSTRAINT "sandbox_conversations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

      ALTER TABLE "ssh_identities" ADD CONSTRAINT "ssh_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_credentials" ADD CONSTRAINT "sandbox_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_members" ADD CONSTRAINT "sandbox_members_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_members" ADD CONSTRAINT "sandbox_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_members" ADD CONSTRAINT "sandbox_members_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

      ALTER TABLE "sandbox_prompt_authors" ADD CONSTRAINT "sandbox_prompt_authors_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_prompt_authors" ADD CONSTRAINT "sandbox_prompt_authors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_session_messages" ADD CONSTRAINT "sandbox_session_messages_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_session_messages" ADD CONSTRAINT "sandbox_session_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sandbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_session_messages" ADD CONSTRAINT "sandbox_session_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_project_links" ADD CONSTRAINT "sandbox_project_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_share_links" ADD CONSTRAINT "sandbox_share_links_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_share_links" ADD CONSTRAINT "sandbox_share_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sandbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "sandbox_share_links" ADD CONSTRAINT "sandbox_share_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "user_integrations" ADD CONSTRAINT "user_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sandbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      ALTER TABLE "user_context_items" ADD CONSTRAINT "user_context_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    $ddl$;
  END IF;
END
$adopt$;

CREATE TABLE IF NOT EXISTS ext_greenhouse.user_limits (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  max_sandboxes integer,
  updated_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ext_greenhouse.user_limits (user_id, max_sandboxes)
SELECT id, max_sandboxes FROM public.users WHERE max_sandboxes IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

DO $compat$
DECLARE
  t text;
  c record;
  tables text[] := ARRAY[
    'sandboxes',
    'sandbox_conversations',
    'ssh_identities',
    'sandbox_credentials',
    'sandbox_members',
    'sandbox_prompt_authors',
    'sandbox_session_messages',
    'sandbox_project_links',
    'sandbox_share_links',
    'user_integrations',
    'slack_link_tokens',
    'sandbox_integration_deliveries',
    'slack_thread_links',
    'user_context_items'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      EXECUTE format('CREATE VIEW public.%I AS SELECT * FROM ext_greenhouse.%I', t, t);
      FOR c IN
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'ext_greenhouse' AND table_name = t AND column_default IS NOT NULL
      LOOP
        EXECUTE format('ALTER VIEW public.%I ALTER COLUMN %I SET DEFAULT %s', t, c.column_name, c.column_default);
      END LOOP;
    END IF;
  END LOOP;
END
$compat$;
