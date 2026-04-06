-- Remove workspace abstraction, merge into projects
CREATE TABLE project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  added_at TIMESTAMP(6) NOT NULL DEFAULT now(),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(project_id, user_id, role_id)
);
CREATE INDEX idx_project_members_project ON project_members(project_id);
CREATE INDEX idx_project_members_user ON project_members(user_id);

CREATE TABLE project_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP(6) NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);
CREATE INDEX idx_project_invitations_project ON project_invitations(project_id);
CREATE INDEX idx_project_invitations_user ON project_invitations(user_id);

ALTER TABLE projects ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
UPDATE projects SET organization_id = w.organization_id FROM workspaces w WHERE projects.workspace_id = w.id;
ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL;

INSERT INTO project_members (id, project_id, user_id, role_id, added_at, added_by)
SELECT gen_random_uuid(), p.id, wm.user_id, wm.role_id, wm.added_at, wm.added_by
FROM projects p JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
ON CONFLICT (project_id, user_id, role_id) DO NOTHING;

INSERT INTO project_invitations (id, project_id, user_id, role_id, invited_by, created_at)
SELECT gen_random_uuid(), p.id, wi.user_id, wi.role_id, wi.invited_by, wi.created_at
FROM projects p JOIN workspace_invitations wi ON wi.workspace_id = p.workspace_id
ON CONFLICT (project_id, user_id) DO NOTHING;

CREATE UNIQUE INDEX projects_organization_id_slug_key ON projects(organization_id, slug);
CREATE INDEX idx_projects_organization ON projects(organization_id);

ALTER TABLE projects DROP CONSTRAINT projects_workspace_id_fkey;
ALTER TABLE projects DROP COLUMN workspace_id;

DROP TABLE workspace_invitations;
DROP TABLE workspace_members;
DROP TABLE workspaces;
