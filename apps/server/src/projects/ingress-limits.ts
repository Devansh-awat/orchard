export interface IngressLimits {
  perDeployment: number;
  perProject: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function ingressLimits(env: NodeJS.ProcessEnv): IngressLimits {
  return {
    perDeployment: positive(env.MAX_INGRESSES_PER_DEPLOYMENT, 20),
    perProject: positive(env.MAX_INGRESSES_PER_PROJECT, 100)
  };
}

export function ingressLimitReached(
  counts: { deployment?: number; project: number },
  limits: IngressLimits
): string | null {
  if (counts.deployment !== undefined && counts.deployment >= limits.perDeployment) {
    return `An app can have at most ${limits.perDeployment} domains`;
  }
  if (counts.project >= limits.perProject) {
    return `A project can have at most ${limits.perProject} domains`;
  }
  return null;
}
