-- CreateTable
CREATE TABLE "org_domains" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "verification_token" VARCHAR(80) NOT NULL,
    "verified_at" TIMESTAMP(6),
    "last_checked_at" TIMESTAMP(6),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "org_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_org_domains_domain" ON "org_domains"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "org_domains_organization_id_domain_key" ON "org_domains"("organization_id", "domain");

-- Many orgs may claim the same domain; only one may ever hold it verified.
-- Enforced in the database so a race between two verifications cannot leave
-- two tenants both owning the namespace.
CREATE UNIQUE INDEX "org_domains_verified_domain_key" ON "org_domains"("domain") WHERE "verified_at" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the previous free-text email_domains list over as UNVERIFIED claims.
-- They were self-asserted, so they must not silently become proof of
-- ownership: each org keeps its list and now has to prove it. gen_random_uuid
-- is available from pgcrypto/pg13+, already relied on elsewhere in this schema.
INSERT INTO "org_domains" ("id", "organization_id", "domain", "verification_token", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    s."organization_id",
    d,
    'orchard-verify-' || encode(gen_random_bytes(16), 'hex'),
    NOW(),
    NOW()
FROM "org_sso_settings" s, unnest(s."email_domains") AS d
WHERE d IS NOT NULL AND d <> ''
ON CONFLICT ("organization_id", "domain") DO NOTHING;

-- AlterTable
ALTER TABLE "org_sso_settings" DROP COLUMN "email_domains";

-- SSO is now opt-in per tenant: a new organization has it off until a platform
-- administrator turns it on. Existing rows are left as they are, because they
-- only exist for orgs whose SSO was already configured and in use — flipping
-- those would sign their members out of the only door they have.
ALTER TABLE "org_sso_settings" ALTER COLUMN "platform_enabled" SET DEFAULT false;
