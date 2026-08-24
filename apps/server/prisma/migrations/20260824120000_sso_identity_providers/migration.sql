-- CreateEnum
CREATE TYPE "sso_protocol" AS ENUM ('oidc', 'saml', 'oauth2');

-- CreateTable
CREATE TABLE "identity_providers" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "protocol" "sso_protocol" NOT NULL,
    "preset" VARCHAR(32) NOT NULL DEFAULT 'generic',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "button_label" VARCHAR(80),
    "icon_url" VARCHAR(500),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "issuer_url" VARCHAR(500),
    "client_id" VARCHAR(255),
    "client_secret" TEXT,
    "scopes" VARCHAR(500),
    "authorization_url" VARCHAR(500),
    "token_url" VARCHAR(500),
    "userinfo_url" VARCHAR(500),
    "saml_entry_point" VARCHAR(500),
    "saml_issuer" VARCHAR(500),
    "saml_idp_entity_id" VARCHAR(500),
    "saml_certificate" TEXT,
    "saml_metadata_url" VARCHAR(500),
    "callback_path" VARCHAR(500),
    "jit_provisioning" BOOLEAN NOT NULL DEFAULT true,
    "default_role" "organization_role" NOT NULL DEFAULT 'member',
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "require_verified_email" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_sso_settings" (
    "organization_id" UUID NOT NULL,
    "platform_enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "email_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "login_logo_url" VARCHAR(500),
    "login_primary_color" VARCHAR(7),
    "login_bg_color" VARCHAR(7),
    "login_welcome_text" VARCHAR(500),
    "login_tagline" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "org_sso_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE INDEX "idx_identity_providers_org" ON "identity_providers"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_providers_organization_id_slug_key" ON "identity_providers"("organization_id", "slug");

-- Postgres treats NULLs as distinct in a unique index, so the composite key
-- above does not constrain instance-wide rows at all. This one does.
CREATE UNIQUE INDEX "identity_providers_instance_slug_key" ON "identity_providers"("slug") WHERE "organization_id" IS NULL;

-- AddForeignKey
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_sso_settings" ADD CONSTRAINT "org_sso_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every existing sso_configs row over as one org-scoped provider. The id
-- is reused so the row stays traceable, and callback_path is pinned to the URL
-- the IdP already has registered: a redirect URI is a contract with the IdP,
-- and silently moving it would break every configured connection on deploy.
INSERT INTO "identity_providers" (
    "id", "organization_id", "slug", "name", "protocol", "preset", "enabled",
    "issuer_url", "client_id", "client_secret", "scopes",
    "saml_entry_point", "saml_issuer", "saml_certificate", "saml_metadata_url",
    "callback_path", "created_at", "updated_at"
)
SELECT
    c."id",
    c."organization_id",
    c."provider",
    CASE WHEN c."provider" = 'saml' THEN 'SAML 2.0' ELSE 'OpenID Connect' END,
    c."provider"::"sso_protocol",
    'generic',
    c."enabled",
    c."oidc_issuer_url",
    c."oidc_client_id",
    c."oidc_client_secret",
    c."oidc_scopes",
    c."saml_entry_point",
    -- The SP entity id used to be derived at request time from the org id.
    -- Materialise it so the value the IdP already trusts survives the move.
    CASE
      WHEN c."provider" = 'saml'
      THEN COALESCE(c."saml_issuer", 'orchard-sso-' || c."organization_id"::text)
      ELSE c."saml_issuer"
    END,
    c."saml_certificate",
    c."saml_metadata_url",
    '/apiv1/sso/' || c."organization_id"::text || '/callback/' || c."provider",
    c."created_at",
    c."updated_at"
FROM "sso_configs" c
WHERE c."provider" IN ('oidc', 'saml');

INSERT INTO "org_sso_settings" (
    "organization_id", "platform_enabled", "enabled", "enforced",
    "login_logo_url", "login_primary_color", "login_bg_color", "login_welcome_text",
    "created_at", "updated_at"
)
SELECT
    c."organization_id",
    true,
    c."enabled",
    c."enforced",
    c."login_logo_url",
    c."login_primary_color",
    c."login_bg_color",
    c."login_welcome_text",
    c."created_at",
    c."updated_at"
FROM "sso_configs" c;

-- DropTable
ALTER TABLE "sso_configs" DROP CONSTRAINT "sso_configs_organization_id_fkey";
DROP TABLE "sso_configs";
