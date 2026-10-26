CREATE TABLE "organization_registry_credentials" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "registry" VARCHAR(255) NOT NULL,
    "username" VARCHAR(255) NOT NULL,
    "password" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "organization_registry_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_registry_credentials_organization_id_registry_key" ON "organization_registry_credentials"("organization_id", "registry");

ALTER TABLE "organization_registry_credentials" ADD CONSTRAINT "organization_registry_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

