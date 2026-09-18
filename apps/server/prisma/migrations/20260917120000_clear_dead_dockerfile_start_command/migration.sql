-- Until now `start_command` only ever reached a Railpack build: docker.service
-- assembled the RAILPACK_* overrides from it and a Dockerfile build skipped
-- that branch entirely. Anything stored against a Dockerfile deployment was
-- therefore dead data, written by the create form, the API, or a build type
-- switched after the fact, and never executed.
--
-- It is about to become the container's args. Waking those values up would
-- restart apps under a command their owner never saw take effect, so clear
-- them once here and let the field be set deliberately from now on.
UPDATE "deployments"
SET "start_command" = NULL
WHERE "build_type" <> 'railpack'
  AND "start_command" IS NOT NULL;
