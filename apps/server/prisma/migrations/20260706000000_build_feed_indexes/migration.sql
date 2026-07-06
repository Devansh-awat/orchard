CREATE INDEX IF NOT EXISTS "idx_deployments_build_status_updated" ON "deployments"("build_status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_image_history_created" ON "image_history"("created_at" DESC);
