CREATE TABLE "registry_credentials" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "registry" VARCHAR(255) NOT NULL,
  "username" VARCHAR(255) NOT NULL,
  "password" TEXT NOT NULL,
  "created_by" UUID,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "registry_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "registry_credentials_project_id_registry_key"
  ON "registry_credentials"("project_id", "registry");

CREATE INDEX "idx_registry_credentials_project" ON "registry_credentials"("project_id");

ALTER TABLE "registry_credentials"
  ADD CONSTRAINT "registry_credentials_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
