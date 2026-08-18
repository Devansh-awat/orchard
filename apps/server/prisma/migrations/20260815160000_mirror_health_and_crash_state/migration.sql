-- AlterTable
ALTER TABLE "k8s_mirror_heartbeats" ADD COLUMN "healthy" BOOLEAN NOT NULL DEFAULT true,
                                    ADD COLUMN "last_error" VARCHAR(300);

-- CreateTable
CREATE TABLE "deployment_crash_states" (
    "deployment_id" UUID NOT NULL,
    "crashing_since" TIMESTAMP(6),
    "healthy_since" TIMESTAMP(6),
    "notified_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "deployment_crash_states_pkey" PRIMARY KEY ("deployment_id")
);

-- AddForeignKey
ALTER TABLE "deployment_crash_states" ADD CONSTRAINT "deployment_crash_states_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "idx_pods_status" ON "pods"("status");
