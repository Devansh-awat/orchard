-- CreateTable
CREATE TABLE "database_pods" (
    "id" UUID NOT NULL,
    "database_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "pod_ip" VARCHAR(45),
    "node_name" VARCHAR(255),
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "restart_count" INTEGER NOT NULL DEFAULT 0,
    "ready" BOOLEAN,
    "last_termination_reason" VARCHAR(100),
    "last_exit_code" INTEGER,
    "last_terminated_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "database_pods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_database_pods_database" ON "database_pods"("database_id");

-- CreateIndex
CREATE INDEX "idx_database_pods_status" ON "database_pods"("status");

-- CreateIndex
CREATE UNIQUE INDEX "database_pods_database_id_name_key" ON "database_pods"("database_id", "name");

-- AddForeignKey
ALTER TABLE "database_pods" ADD CONSTRAINT "database_pods_database_id_fkey" FOREIGN KEY ("database_id") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "database_crash_states" (
    "database_id" UUID NOT NULL,
    "crashing_since" TIMESTAMP(6),
    "healthy_since" TIMESTAMP(6),
    "notified_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "database_crash_states_pkey" PRIMARY KEY ("database_id")
);

-- AddForeignKey
ALTER TABLE "database_crash_states" ADD CONSTRAINT "database_crash_states_database_id_fkey" FOREIGN KEY ("database_id") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
