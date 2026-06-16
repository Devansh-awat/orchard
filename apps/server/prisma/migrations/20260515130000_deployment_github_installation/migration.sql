-- Bind each deployment to the GitHub App installation that owns its repo.
-- Webhook handlers compare body.installation.id against this column so a
-- repo full_name cannot be impersonated by another installation.
ALTER TABLE "deployments" ADD COLUMN "github_installation_id" BIGINT;
