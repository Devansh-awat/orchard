-- CreateTable
CREATE TABLE IF NOT EXISTS "tcp_ingresses" (
    "id" UUID NOT NULL,
    "namespace" VARCHAR(100),
    "service_name" VARCHAR(255),
    "service_port" INTEGER,
    "host" VARCHAR(255),
    "external_port" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tcp_ingresses_pkey" PRIMARY KEY ("id")
);

