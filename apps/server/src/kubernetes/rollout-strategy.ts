export function rollingUpdateStrategy() {
  return {
    type: 'RollingUpdate' as const,
    rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 }
  };
}
