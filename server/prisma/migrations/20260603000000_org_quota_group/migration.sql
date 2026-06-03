-- Connected orgs: orgs with the same quota_group_id share caps + usage pool.
ALTER TABLE "organizations" ADD COLUMN "quota_group_id" UUID;
CREATE INDEX "idx_organizations_quota_group" ON "organizations"("quota_group_id");
