-- AlterTable
ALTER TABLE "database_pods" ADD COLUMN     "current_primary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "databases" ADD COLUMN     "cluster_status" JSONB,
ADD COLUMN     "cluster_synced_at" TIMESTAMP(6),
ADD COLUMN     "connections" INTEGER,
ADD COLUMN     "size_bytes" BIGINT,
ADD COLUMN     "stats_at" TIMESTAMP(6);

