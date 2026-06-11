-- Optional project target on organization invitations: lets a project admin
-- invite a brand-new email as an org guest + project member in one step.
ALTER TABLE "organization_invitations" ADD COLUMN "project_id" UUID;
ALTER TABLE "organization_invitations" ADD COLUMN "project_role_id" UUID;

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_project_role_id_fkey"
  FOREIGN KEY ("project_role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "idx_organization_invitations_project" ON "organization_invitations"("project_id");
