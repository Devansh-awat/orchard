CREATE TYPE "ingress_protection_mode" AS ENUM ('none', 'password', 'orchard');

ALTER TABLE "ingresses" ADD COLUMN "protection_mode" "ingress_protection_mode" NOT NULL DEFAULT 'none';
ALTER TABLE "ingresses" ADD COLUMN "protection_password_hash" VARCHAR(255);
ALTER TABLE "ingresses" ADD COLUMN "protection_bypass_secret" VARCHAR(128);
