-- Which first-run setup steps the operator explicitly skipped. Only skips are
-- stored: whether a step is *done* is derived from the thing it produces (a
-- passkey, an organization, a deployment), so it can never disagree with
-- reality the way a stored checklist does.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "setup_skipped" TEXT[] NOT NULL DEFAULT '{}';
