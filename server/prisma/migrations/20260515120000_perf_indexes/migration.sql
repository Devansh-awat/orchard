-- Perf indexes for hot lookup patterns identified during the perf pass.

-- removeMemberFromOrganization fans out a findMany on Deployment by
-- (tailscaleExposedBy, project.organizationId) to tear down Tailscale
-- sidecars. Without this, removing a user from an org with a large
-- Deployment table scanned every row.
CREATE INDEX IF NOT EXISTS "idx_deployments_tailscale_exposed_by"
  ON "deployments" ("tailscale_exposed_by");

-- ImageHistory rollback / active-image lookups all filter by
-- (deploymentId, isActive=true). The existing (deploymentId) index was
-- adequate while history was small but degrades quickly per deployment.
CREATE INDEX IF NOT EXISTS "idx_image_history_deployment_active"
  ON "image_history" ("deployment_id", "is_active");
