-- DropIndex
DROP INDEX IF EXISTS "project_members_project_id_user_id_role_id_key";

-- CreateIndex (one membership per user per project — role is mutable, not part of the key)
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");
