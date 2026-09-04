-- Auto-deploy used to match a push to its deployments purely on the repository
-- URL. Renaming a repository on GitHub therefore detached every deployment
-- built from it, silently: the webhook arrives under the new full name, the
-- lookup matches nothing, and the push is ignored with no error raised
-- anywhere. The numeric repository id is the one identifier a rename does not
-- change, so it becomes the primary key of that match.
--
-- Left NULL here on purpose. The reconciler in GitHubService fills it in for
-- existing rows (from the repo mirror where the name still matches, and from
-- the GitHub API where it does not, which is how already-renamed repos are
-- recovered), and the push handler adopts it for anything it matches by URL.
ALTER TABLE "deployments" ADD COLUMN "github_repo_id" BIGINT;

CREATE INDEX "idx_deployments_github_repo_id" ON "deployments"("github_repo_id");
