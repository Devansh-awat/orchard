ALTER TABLE "deployment_volumes"
  ADD COLUMN "observed_capacity" VARCHAR(20),
  ADD COLUMN "phase" VARCHAR(20),
  ADD COLUMN "resize_state" VARCHAR(20),
  ADD COLUMN "resize_message" VARCHAR(500),
  ADD COLUMN "observed_at" TIMESTAMP(6);

CREATE INDEX "idx_deployment_volumes_pvc_name" ON "deployment_volumes"("pvc_name");
