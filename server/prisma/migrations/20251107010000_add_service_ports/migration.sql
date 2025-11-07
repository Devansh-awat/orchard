-- CreateTable
CREATE TABLE "service_ports" (
    "id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "name" VARCHAR(63),
    "port" INTEGER NOT NULL,
    "target_port" INTEGER NOT NULL,
    "protocol" VARCHAR(10) NOT NULL DEFAULT 'TCP',

    CONSTRAINT "service_ports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_service_ports_service" ON "service_ports"("service_id");

-- AddForeignKey
ALTER TABLE "service_ports" ADD CONSTRAINT "service_ports_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

