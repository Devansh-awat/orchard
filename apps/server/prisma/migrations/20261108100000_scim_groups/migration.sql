-- CreateTable
CREATE TABLE "scim_groups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "display_name" VARCHAR(256) NOT NULL,
    "external_id" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "scim_group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateIndex
CREATE INDEX "idx_scim_groups_org" ON "scim_groups"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_organization_id_display_name_key" ON "scim_groups"("organization_id", "display_name");

-- CreateIndex
CREATE INDEX "idx_scim_group_members_org_user" ON "scim_group_members"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "scim_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
