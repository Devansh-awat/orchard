-- Demote the host unique index to a plain index. Shared ingresses create
-- multiple rows with the same host (one per path route) within a project.
-- Cross-project hostname uniqueness is enforced at the application layer
-- by assertHostnameAvailable; the DB index is kept for query performance.

DROP INDEX IF EXISTS "idx_ingresses_host_unique";
CREATE INDEX "idx_ingresses_host" ON "ingresses" ("host");
