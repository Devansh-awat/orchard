ALTER TABLE "service_ports"
  ADD COLUMN "public_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "public_port" INTEGER;
