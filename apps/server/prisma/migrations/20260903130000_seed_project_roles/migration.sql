-- Project roles are reference data, not demo data: every project membership
-- operation resolves `roles.name` to an id. They were only ever created by
-- prisma/seed.ts, which is a manual dev command and is not runnable in the
-- production image, so self-hosted installs ran with an empty table forever:
-- adding a member 400'd with "Invalid role: member", and project creation
-- silently produced zero members. Seed them here so `migrate deploy` (which
-- the container entrypoint already runs) self-heals existing installs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO "roles" ("id", "name", "description")
VALUES
    (gen_random_uuid(), 'admin', 'Full administrative access to workspace'),
    (gen_random_uuid(), 'member', 'Standard member access to workspace'),
    (gen_random_uuid(), 'viewer', 'Read-only access to workspace resources')
ON CONFLICT ("name") DO NOTHING;

-- Backfill projects created while the table was empty. Those rows lost their
-- creator membership with no error, which also left the "last admin" guards
-- inert. Re-add the owner (falling back to the creator) as an admin.
INSERT INTO "project_members" ("id", "project_id", "user_id", "role_id", "added_by")
SELECT gen_random_uuid(), p."id", COALESCE(p."owner_id", p."created_by"), r."id", COALESCE(p."owner_id", p."created_by")
FROM "projects" p
CROSS JOIN (SELECT "id" FROM "roles" WHERE "name" = 'admin') r
WHERE COALESCE(p."owner_id", p."created_by") IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "project_members" m WHERE m."project_id" = p."id")
ON CONFLICT ("project_id", "user_id") DO NOTHING;
