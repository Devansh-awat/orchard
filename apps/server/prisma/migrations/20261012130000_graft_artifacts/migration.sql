-- CreateTable
CREATE TABLE "graft_artifacts" (
    "digest" VARCHAR(80) NOT NULL,
    "graft_id" VARCHAR(48) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graft_artifacts_pkey" PRIMARY KEY ("digest")
);

-- CreateIndex
CREATE INDEX "graft_artifacts_graft_id_idx" ON "graft_artifacts"("graft_id");
