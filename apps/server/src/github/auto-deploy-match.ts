export interface AutoDeployBranchTarget {
  autoDeployBranch: string | null;
  githubBranch: string | null;
}

export function autoDeployTargetBranch(deployment: AutoDeployBranchTarget): string | null {
  return deployment.autoDeployBranch ?? deployment.githubBranch ?? null;
}

export function autoDeployMatchesBranch(
  deployment: AutoDeployBranchTarget,
  pushedBranch: string,
): boolean {
  const target = autoDeployTargetBranch(deployment);
  return !!target && target === pushedBranch;
}
