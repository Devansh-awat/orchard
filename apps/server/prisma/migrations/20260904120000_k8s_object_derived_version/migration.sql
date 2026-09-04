-- Tracks the resourceVersion whose derived state (pods rows, k8s_workloads
-- rows, job runs) has actually been written, separately from the manifest
-- version we hold. The relist skips a row only when the two agree, so a
-- consumer that failed gets retried instead of being skipped forever behind an
-- already-current manifest.
--
-- Deliberately left NULL for existing rows: the first list after this deploys
-- re-derives every mirrored object once, which repairs everything that rotted
-- under the old skip rule.
ALTER TABLE "k8s_objects" ADD COLUMN "derived_version" VARCHAR(30);
