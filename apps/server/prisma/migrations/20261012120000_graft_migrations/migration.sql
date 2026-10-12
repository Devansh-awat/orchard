-- CreateTable
CREATE TABLE "graft_migrations" (
    "graft_id" VARCHAR(48) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graft_migrations_pkey" PRIMARY KEY ("graft_id","name")
);
