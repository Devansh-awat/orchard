ALTER TABLE "databases"
  ADD COLUMN "volume_used_bytes" BIGINT,
  ADD COLUMN "volume_capacity_bytes" BIGINT,
  ADD COLUMN "wal_pending_segments" INTEGER;
