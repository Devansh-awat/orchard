-- SCIM provisioning state on memberships: a membership is the unit an IdP
-- provisions, so the SCIM resource id maps to organization_members.id.
ALTER TABLE "organization_members" ADD COLUMN "scim_external_id" VARCHAR(255);
ALTER TABLE "organization_members" ADD COLUMN "scim_managed" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "idx_organization_members_scim_external"
  ON "organization_members"("organization_id", "scim_external_id");

-- Long-lived per-org bearer tokens the IdP presents to the SCIM endpoints.
-- Only the sha256 digest is stored.
CREATE TABLE "scim_tokens" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "name"            VARCHAR(255) NOT NULL,
  "token_hash"      VARCHAR(128) NOT NULL,
  "created_by"      UUID,
  "last_used_at"    TIMESTAMP(6),
  "expires_at"      TIMESTAMP(6),
  "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scim_tokens_token_hash_key" ON "scim_tokens"("token_hash");
CREATE INDEX "idx_scim_tokens_org" ON "scim_tokens"("organization_id");

ALTER TABLE "scim_tokens"
  ADD CONSTRAINT "scim_tokens_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
