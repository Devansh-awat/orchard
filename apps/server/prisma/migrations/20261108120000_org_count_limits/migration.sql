-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "max_deployments" INTEGER,
ADD COLUMN     "max_environments" INTEGER,
ADD COLUMN     "max_projects" INTEGER;
