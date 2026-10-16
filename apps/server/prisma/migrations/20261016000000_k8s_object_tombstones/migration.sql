-- CreateTable
CREATE TABLE "k8s_object_tombstones" (
    "uid" VARCHAR(64) NOT NULL,
    "shard" VARCHAR(40) NOT NULL,
    "kind" VARCHAR(60) NOT NULL,
    "manifest" JSONB NOT NULL,
    "buried_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "k8s_object_tombstones_pkey" PRIMARY KEY ("uid")
);

-- CreateIndex
CREATE INDEX "idx_k8s_object_tombstones_shard_kind" ON "k8s_object_tombstones"("shard", "kind");

