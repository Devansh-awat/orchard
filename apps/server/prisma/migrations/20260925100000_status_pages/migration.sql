-- CreateTable
CREATE TABLE "status_pages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "subdomain" VARCHAR(100),
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "components" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "status_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "status_pages_slug_key" ON "status_pages"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "status_pages_subdomain_key" ON "status_pages"("subdomain");

-- CreateIndex
CREATE INDEX "idx_status_pages_org" ON "status_pages"("organization_id");

-- AddForeignKey
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

