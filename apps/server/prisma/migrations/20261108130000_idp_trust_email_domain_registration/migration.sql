-- AlterTable
ALTER TABLE "identity_providers" ADD COLUMN     "trust_email" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "org_domains" ADD COLUMN     "missing_since" TIMESTAMP(6),
ADD COLUMN     "registered_at" TIMESTAMP(6);

