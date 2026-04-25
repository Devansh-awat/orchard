-- CreateTable
CREATE TABLE "tailscale_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "tailnet" VARCHAR(255) NOT NULL,
    "tailscale_user_id" VARCHAR(255),
    "display_name" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "tailscale_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tailscale_connections_user_id_key" ON "tailscale_connections"("user_id");

-- CreateIndex
CREATE INDEX "idx_tailscale_connections_user" ON "tailscale_connections"("user_id");

-- AddForeignKey
ALTER TABLE "tailscale_connections" ADD CONSTRAINT "tailscale_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable - Add Tailscale fields to deployments
ALTER TABLE "deployments" ADD COLUMN "tailscale_exposed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deployments" ADD COLUMN "tailscale_hostname" VARCHAR(255);
ALTER TABLE "deployments" ADD COLUMN "tailscale_exposed_by" UUID;
