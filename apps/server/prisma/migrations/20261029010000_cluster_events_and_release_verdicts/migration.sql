ALTER TABLE "releases" ADD COLUMN "settled_at" TIMESTAMP(6),
ADD COLUMN "verdict" JSONB,
ADD COLUMN "verdict_at" TIMESTAMP(6);

CREATE TABLE "cluster_events" (
    "id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "deployment_id" UUID,
    "namespace" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(100) NOT NULL,
    "object_name" VARCHAR(255) NOT NULL,
    "node_name" VARCHAR(255),
    "message" VARCHAR(1000),
    "count" INTEGER NOT NULL DEFAULT 1,
    "at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cluster_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cluster_events_key_key" ON "cluster_events"("key");
CREATE INDEX "idx_cluster_events_deployment_at" ON "cluster_events"("deployment_id", "at" DESC);
CREATE INDEX "idx_cluster_events_at" ON "cluster_events"("at");

ALTER TABLE "cluster_events" ADD CONSTRAINT "cluster_events_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
