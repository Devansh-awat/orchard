-- Widen the ingress unique constraint to include `path`.
-- A single Kubernetes Ingress resource can route multiple paths, each tracked
-- as a separate DB row sharing the same (namespace, name). The old
-- UNIQUE(namespace, name) rejected the second row on merge; adding `path`
-- allows one row per route while still preventing true duplicates.

DROP INDEX IF EXISTS "ingresses_namespace_name_key";
CREATE UNIQUE INDEX "ingresses_namespace_name_path_key" ON "ingresses" ("namespace", "name", "path");
