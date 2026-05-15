-- C-2: support fast global hostname-availability checks across projects.
-- The application enforces "no two projects may register the same host"
-- in ProjectsService.assertHostnameAvailable; this index makes the check
-- O(log n) on the host column.
CREATE INDEX IF NOT EXISTS "idx_ingresses_host" ON "ingresses" ("host");
