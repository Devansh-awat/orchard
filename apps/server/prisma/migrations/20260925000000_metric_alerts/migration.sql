-- CreateTable
CREATE TABLE "metric_alert_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope_type" VARCHAR(20) NOT NULL,
    "scope_id" UUID,
    "metric" VARCHAR(40) NOT NULL,
    "comparator" VARCHAR(4) NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "for_seconds" INTEGER NOT NULL DEFAULT 300,
    "min_request_rate" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "metric_alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_alert_states" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "firing_since" TIMESTAMP(6),
    "ok_since" TIMESTAMP(6),
    "notified_at" TIMESTAMP(6),
    "unknown_since" TIMESTAMP(6),
    "last_value" DOUBLE PRECISION,
    "last_evaluated_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "metric_alert_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_metric_alert_rules_scope" ON "metric_alert_rules"("organization_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "idx_metric_alert_rules_enabled" ON "metric_alert_rules"("enabled");

-- CreateIndex
CREATE INDEX "idx_metric_alert_states_target" ON "metric_alert_states"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_metric_alert_state_rule_target" ON "metric_alert_states"("rule_id", "target_id");

-- AddForeignKey
ALTER TABLE "metric_alert_rules" ADD CONSTRAINT "metric_alert_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_alert_rules" ADD CONSTRAINT "metric_alert_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_alert_states" ADD CONSTRAINT "metric_alert_states_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "metric_alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

