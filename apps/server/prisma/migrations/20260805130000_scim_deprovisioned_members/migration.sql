-- CreateTable
CREATE TABLE "scim_deprovisioned_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "external_id" VARCHAR(255),
    "role" "organization_role" NOT NULL DEFAULT 'member',
    "deactivated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_deprovisioned_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_scim_deprovisioned_org" ON "scim_deprovisioned_members"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_deprovisioned_members_organization_id_user_id_key" ON "scim_deprovisioned_members"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "scim_deprovisioned_members" ADD CONSTRAINT "scim_deprovisioned_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_deprovisioned_members" ADD CONSTRAINT "scim_deprovisioned_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
