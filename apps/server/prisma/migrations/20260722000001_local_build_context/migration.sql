-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "build_context_key" VARCHAR(500),
ADD COLUMN     "build_context_sha" VARCHAR(100);

