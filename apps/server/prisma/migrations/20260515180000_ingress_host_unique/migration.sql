-- assertHostnameAvailable is a TOCTOU check: two concurrent CreateIngress
-- requests can both pass the "is this host free?" query and then both insert
-- the same host. The previous non-unique index made the lookup fast but did
-- not prevent the race. Promote it to a unique index so the database rejects
-- the second insert; the service-level check stays as the user-facing error
-- and the unique violation is the backstop.

DROP INDEX IF EXISTS "idx_ingresses_host";
CREATE UNIQUE INDEX "idx_ingresses_host_unique" ON "ingresses" ("host");
