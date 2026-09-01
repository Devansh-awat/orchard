ALTER TABLE "deployments" ADD COLUMN "auto_deploy_paths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
