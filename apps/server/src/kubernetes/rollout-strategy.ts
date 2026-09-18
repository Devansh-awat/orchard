export const ROLLOUT_MIN_READY_SECONDS = 10;

export function rollingUpdateStrategy() {
  return {
    type: 'RollingUpdate' as const,
    rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 }
  };
}
