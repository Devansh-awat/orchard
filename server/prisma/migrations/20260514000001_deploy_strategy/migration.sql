-- Add per-deployment Kubernetes update strategy (RollingUpdate vs Recreate).
-- Forced to Recreate by the backend whenever a PVC volume is attached, since
-- ReadWriteOnce PVCs can't be held by two pods during a rolling cutover.

CREATE TYPE "deployment_strategy" AS ENUM ('rollingUpdate', 'recreate');

ALTER TABLE "deployments"
  ADD COLUMN "deploy_strategy" "deployment_strategy" NOT NULL DEFAULT 'rollingUpdate';
