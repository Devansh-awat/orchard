-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "managed_by_provider_id" UUID;

-- AlterTable
ALTER TABLE "identity_providers" ADD COLUMN     "group_claim" VARCHAR(256) NOT NULL DEFAULT 'groups';

-- CreateTable
CREATE TABLE "federated_identities" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federated_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idp_group_rules" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "value" VARCHAR(256) NOT NULL,
    "role" "organization_role" NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idp_group_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_federated_identities_user" ON "federated_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "federated_identities_provider_id_subject_key" ON "federated_identities"("provider_id", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "federated_identities_provider_id_user_id_key" ON "federated_identities"("provider_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_idp_group_rules_org" ON "idp_group_rules"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "idp_group_rules_provider_id_organization_id_value_key" ON "idp_group_rules"("provider_id", "organization_id", "value");

-- CreateIndex
CREATE INDEX "idx_organization_members_managed_by" ON "organization_members"("managed_by_provider_id");

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_managed_by_provider_id_fkey" FOREIGN KEY ("managed_by_provider_id") REFERENCES "identity_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federated_identities" ADD CONSTRAINT "federated_identities_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federated_identities" ADD CONSTRAINT "federated_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_group_rules" ADD CONSTRAINT "idp_group_rules_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_group_rules" ADD CONSTRAINT "idp_group_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
