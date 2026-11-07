export const TAILSCALE_EGRESS_EXCEPT = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10'
] as const;

export const DEFAULT_TAILSCALE_IMAGE = 'ghcr.io/tailscale/tailscale:latest';

export const tailscaleImage = (): string =>
  process.env.TAILSCALE_IMAGE?.trim() || DEFAULT_TAILSCALE_IMAGE;

export const tailscaleSecurityContext = () => ({
  runAsUser: 1000,
  runAsGroup: 1000,
  runAsNonRoot: true,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' as const }
});
