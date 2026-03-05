-- CreateTable
CREATE TABLE "databases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "db_name" VARCHAR(63) NOT NULL,
    "db_user" VARCHAR(63) NOT NULL,
    "db_password" VARCHAR(255) NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "host" VARCHAR(255) NOT NULL DEFAULT 'postgresql-cluster-rw.postgresql.svc.cluster.local',
    "port" INTEGER NOT NULL DEFAULT 5432,
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "databases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_databases_project" ON "databases"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "databases_project_id_name_key" ON "databases"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "databases_db_name_key" ON "databases"("db_name");

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
