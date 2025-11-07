-- AlterTable
ALTER TABLE "tcp_ingresses"
  ADD COLUMN "host" VARCHAR(255),
  ADD COLUMN "external_port" INTEGER;

