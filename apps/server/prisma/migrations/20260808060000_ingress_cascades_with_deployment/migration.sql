-- An ingress belongs to its deployment: without one there is nothing to route
-- to, and the row is unreachable from the UI (every listing goes via
-- deployment_id). SET NULL left those rows behind on every delete, still
-- carrying protection_mode, where the protection reconciler retried them
-- forever and resolveIngressFromHost could match a stale host.
--
-- Matches the services.deployment_id rule, which has always been CASCADE.
ALTER TABLE "ingresses" DROP CONSTRAINT "ingresses_deployment_id_fkey";

ALTER TABLE "ingresses" ADD CONSTRAINT "ingresses_deployment_id_fkey"
  FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
