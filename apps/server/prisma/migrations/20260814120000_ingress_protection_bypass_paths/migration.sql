ALTER TABLE "ingresses" ADD COLUMN "protection_bypass_paths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
