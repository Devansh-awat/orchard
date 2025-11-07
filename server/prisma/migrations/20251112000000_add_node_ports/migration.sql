ALTER TABLE "services"
ADD COLUMN "node_port" INTEGER;

ALTER TABLE "service_ports"
ADD COLUMN "node_port" INTEGER;

