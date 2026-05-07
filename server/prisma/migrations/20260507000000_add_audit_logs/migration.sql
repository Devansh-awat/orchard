-- Append-only audit log ledger
CREATE TABLE "audit_logs" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "created_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "action"           VARCHAR(80) NOT NULL,
  "actor_user_id"    UUID,
  "actor_email"      VARCHAR(255),
  "organization_id"  UUID,
  "project_id"       UUID,
  "deployment_id"    UUID,
  "target_type"      VARCHAR(40),
  "target_id"        VARCHAR(64),
  "target_label"     VARCHAR(255),
  "metadata"         JSONB,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_audit_logs_created"    ON "audit_logs" ("created_at" DESC);
CREATE INDEX "idx_audit_logs_org"        ON "audit_logs" ("organization_id", "created_at" DESC);
CREATE INDEX "idx_audit_logs_project"    ON "audit_logs" ("project_id", "created_at" DESC);
CREATE INDEX "idx_audit_logs_deployment" ON "audit_logs" ("deployment_id", "created_at" DESC);
CREATE INDEX "idx_audit_logs_actor"      ON "audit_logs" ("actor_user_id", "created_at" DESC);
