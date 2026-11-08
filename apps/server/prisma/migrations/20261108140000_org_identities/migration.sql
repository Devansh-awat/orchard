-- CreateEnum
CREATE TYPE "member_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "member_source" AS ENUM ('invite', 'sso', 'scim', 'rule', 'direct');

-- DropIndex
DROP INDEX "users_email_key";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabled_at" TIMESTAMP(6),
ADD COLUMN     "disabled_reason" VARCHAR(255),
ADD COLUMN     "email_scope" VARCHAR(64) NOT NULL DEFAULT 'account',
ADD COLUMN     "email_verified_via" VARCHAR(20),
ADD COLUMN     "home_organization_id" UUID,
ADD COLUMN     "passkey_only" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "disabled_at" TIMESTAMP(6),
ADD COLUMN     "disabled_reason" VARCHAR(255),
ADD COLUMN     "source" "member_source",
ADD COLUMN     "status" "member_status" NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "org_sso_settings" ADD COLUMN     "guests_use_own_login" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "max_session_hours" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "scim_only_sign_in" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "account_links" (
    "id" UUID NOT NULL,
    "identity_user_id" UUID NOT NULL,
    "account_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_org_grants" (
    "session_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider_id" UUID,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_org_grants_pkey" PRIMARY KEY ("session_id","organization_id")
);

-- CreateTable
CREATE TABLE "idp_project_rules" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "value" VARCHAR(256) NOT NULL,
    "role_id" UUID NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idp_project_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_links_identity_user_id_key" ON "account_links"("identity_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_links_account_user_id_organization_id_key" ON "account_links"("account_user_id", "organization_id");

-- CreateIndex
CREATE INDEX "idx_session_org_grants_expires" ON "session_org_grants"("expires_at");

-- CreateIndex
CREATE INDEX "idx_idp_project_rules_org" ON "idp_project_rules"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "idp_project_rules_provider_id_project_id_value_key" ON "idp_project_rules"("provider_id", "project_id", "value");

-- CreateIndex
CREATE INDEX "idx_users_home_organization" ON "users"("home_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_scope_email_key" ON "users"("email_scope", "email");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_home_organization_id_fkey" FOREIGN KEY ("home_organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_identity_user_id_fkey" FOREIGN KEY ("identity_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_account_user_id_fkey" FOREIGN KEY ("account_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_org_grants" ADD CONSTRAINT "session_org_grants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_org_grants" ADD CONSTRAINT "session_org_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_project_rules" ADD CONSTRAINT "idp_project_rules_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_project_rules" ADD CONSTRAINT "idp_project_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_project_rules" ADD CONSTRAINT "idp_project_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_project_rules" ADD CONSTRAINT "idp_project_rules_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

