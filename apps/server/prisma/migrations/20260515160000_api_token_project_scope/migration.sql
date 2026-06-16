ALTER TABLE "api_tokens" ADD COLUMN "restricted_project_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
