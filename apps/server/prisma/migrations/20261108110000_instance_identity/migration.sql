-- AlterTable
ALTER TABLE "federated_identities" ADD COLUMN     "granted_superadmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "idp_auto_create_rules" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "value" VARCHAR(256) NOT NULL,
    "role" "organization_role" NOT NULL,
    "organization_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idp_auto_create_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idp_auto_create_rules_organization_id_key" ON "idp_auto_create_rules"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "idp_auto_create_rules_provider_id_value_key" ON "idp_auto_create_rules"("provider_id", "value");

-- AddForeignKey
ALTER TABLE "idp_auto_create_rules" ADD CONSTRAINT "idp_auto_create_rules_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_auto_create_rules" ADD CONSTRAINT "idp_auto_create_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
