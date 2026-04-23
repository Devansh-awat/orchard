ALTER TABLE "deployments"
  ADD COLUMN "cpu_request_milli" INTEGER,
  ADD COLUMN "memory_request_bytes" BIGINT;

ALTER TABLE "databases"
  ADD COLUMN "cpu_request_milli" INTEGER,
  ADD COLUMN "memory_request_bytes" BIGINT;
