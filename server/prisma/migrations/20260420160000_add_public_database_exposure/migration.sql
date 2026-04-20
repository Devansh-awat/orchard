ALTER TABLE "organizations" ADD COLUMN "database_public_ip" VARCHAR(45);

ALTER TABLE "databases"
  ADD COLUMN "public_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "public_ip" VARCHAR(45),
  ADD COLUMN "public_port" INTEGER;

CREATE INDEX "idx_databases_public_endpoint" ON "databases" ("public_ip", "public_port");
