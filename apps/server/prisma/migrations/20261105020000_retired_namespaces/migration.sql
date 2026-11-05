-- CreateTable
CREATE TABLE "retired_namespaces" (
    "namespace" VARCHAR(100) NOT NULL,
    "retired_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_namespaces_pkey" PRIMARY KEY ("namespace")
);
