-- CreateTable
CREATE TABLE "github_repo_mirror" (
    "id" UUID NOT NULL,
    "app_installation_id" UUID NOT NULL,
    "github_repo_id" BIGINT NOT NULL,
    "full_name" VARCHAR(255) NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "default_branch" VARCHAR(255),
    "pushed_at" TIMESTAMP(6),
    "synced_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_repo_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_github_repo_mirror_pushed" ON "github_repo_mirror"("app_installation_id", "pushed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "github_repo_mirror_app_installation_id_github_repo_id_key" ON "github_repo_mirror"("app_installation_id", "github_repo_id");

-- AddForeignKey
ALTER TABLE "github_repo_mirror" ADD CONSTRAINT "github_repo_mirror_app_installation_id_fkey" FOREIGN KEY ("app_installation_id") REFERENCES "github_app_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

