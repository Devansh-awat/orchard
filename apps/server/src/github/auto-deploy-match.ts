export interface AutoDeployBranchTarget {
  autoDeployBranch: string | null;
  githubBranch: string | null;
}

export function autoDeployTargetBranch(deployment: AutoDeployBranchTarget): string | null {
  return deployment.autoDeployBranch ?? deployment.githubBranch ?? null;
}

export function autoDeployMatchesBranch(
  deployment: AutoDeployBranchTarget,
  pushedBranch: string
): boolean {
  const target = autoDeployTargetBranch(deployment);
  return !!target && target === pushedBranch;
}

/**
 * The stored `githubRepo` spellings that mean this repository. Legacy rows kept
 * a `.git` suffix, so both are matched.
 */
export function repoUrlVariants(fullName: string): string[] {
  const url = `https://github.com/${fullName}`;
  return [url, `${url}.git`];
}

/**
 * The URL a row should hold for `fullName`, preserving whatever `.git` suffix
 * convention it already had so a rename does not quietly restyle the row.
 */
export function canonicalRepoUrl(existing: string | null | undefined, fullName: string): string {
  const suffix = existing?.endsWith('.git') ? '.git' : '';
  return `https://github.com/${fullName}${suffix}`;
}

const NULL_SHA = /^0+$/;

/** git's "no such commit" sha, which is what a deleted ref reports. */
export function isNullSha(sha: string | null | undefined): boolean {
  return !sha || NULL_SHA.test(sha);
}

/**
 * The commit a push is asking us to deploy, or null when there isn't one.
 *
 * Deleting a branch arrives as a push to that same ref: same event, same
 * branch name, `deleted` set, and `after` as the null sha. Taking it at face
 * value starts a build of a commit that does not exist — which is what a
 * deployment tracking a feature branch gets on the day that branch is merged
 * and tidied up.
 */
export function pushCommitSha(body: {
  deleted?: boolean;
  after?: string;
  head_commit?: { id?: string } | null;
}): string | null {
  if (body?.deleted === true) return null;
  const sha = body?.after || body?.head_commit?.id;
  return isNullSha(sha) ? null : (sha as string);
}
