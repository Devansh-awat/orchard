import type { IngressProtectionMode } from '@prisma/client';

export interface AutoUrlChoice {
  servicePort?: number;
  isPublic?: boolean;
  composePort?: boolean;
}

interface RequestedPort {
  reach?: unknown;
  containerPort?: unknown;
  servicePort?: unknown;
}

interface ExistingService {
  port?: number | null;
  ports?: { port: number }[] | null;
}

export function autoUrlChoice(ports: RequestedPort[] | null | undefined): AutoUrlChoice {
  if (!Array.isArray(ports)) return {};
  const linked = ports.find((p) => p?.reach === 'link' || p?.reach === 'public-link');
  if (!linked) return {};
  const port = Number(linked.servicePort ?? linked.containerPort);
  return {
    ...(Number.isInteger(port) && port > 0 ? { servicePort: port } : {}),
    isPublic: linked.reach === 'public-link'
  };
}

export function autoUrlProtection(
  choice: AutoUrlChoice,
  services: ExistingService[]
): IngressProtectionMode {
  if (!choice.isPublic || !choice.servicePort) return 'orchard';
  const served = services.some(
    (s) => s.port === choice.servicePort || s.ports?.some((p) => p.port === choice.servicePort)
  );
  return served ? 'none' : 'orchard';
}
