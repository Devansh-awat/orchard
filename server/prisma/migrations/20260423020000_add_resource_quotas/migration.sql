ALTER TABLE "organizations"
  ADD COLUMN "cpu_limit_milli" INTEGER,
  ADD COLUMN "memory_limit_bytes" BIGINT,
  ADD COLUMN "max_pods" INTEGER,
  ADD COLUMN "max_services" INTEGER,
  ADD COLUMN "default_pod_cpu_milli" INTEGER,
  ADD COLUMN "default_pod_memory_bytes" BIGINT;

ALTER TABLE "projects"
  ADD COLUMN "cpu_limit_milli" INTEGER,
  ADD COLUMN "memory_limit_bytes" BIGINT,
  ADD COLUMN "max_pods" INTEGER,
  ADD COLUMN "max_services" INTEGER;
