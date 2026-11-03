import type * as k8s from '@kubernetes/client-node';

export const BUILD_ARCHES = ['amd64', 'arm64'] as const;
export type BuildArch = (typeof BUILD_ARCHES)[number];

const ARCH_ALIASES: Record<string, BuildArch> = {
  amd64: 'amd64',
  x86_64: 'amd64',
  x64: 'amd64',
  arm64: 'arm64',
  aarch64: 'arm64'
};

export function parseBuildArch(raw: string | undefined): BuildArch {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'amd64';
  const arch = ARCH_ALIASES[value.replace(/^linux\//, '')];
  if (!arch) {
    throw new Error(`BUILD_PLATFORM must be linux/amd64 or linux/arm64, got "${raw}"`);
  }
  return arch;
}

export const BUILD_ARCH: BuildArch = parseBuildArch(process.env.BUILD_PLATFORM);
export const BUILD_PLATFORM = `linux/${BUILD_ARCH}`;
export const PIN_WORKLOADS_TO_BUILD_ARCH = Boolean(process.env.BUILD_PLATFORM?.trim());

export const ARCH_NODE_LABEL = 'kubernetes.io/arch';

export function buildArchNodeSelector(): Record<string, string> {
  return { [ARCH_NODE_LABEL]: BUILD_ARCH };
}

export function assertBuildRegistryConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const missing = ['DOCKER_REGISTRY_PUSH', 'DOCKER_REGISTRY_PULL'].filter(
    (name) => !env[name]?.trim()
  );
  if (missing.length === 0) return;
  throw new Error(
    `Image builds need a container registry, but ${missing.join(' and ')} ${
      missing.length === 1 ? 'is' : 'are'
    } not set on the server. Point them at your registry and restart the server.`
  );
}

function platformRegistryHosts(): string[] {
  return [process.env.DOCKER_REGISTRY_PULL, process.env.DOCKER_REGISTRY_PUSH]
    .filter((h): h is string => Boolean(h))
    .map((h) =>
      h
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '')
        .toLowerCase()
    );
}

export function isPlatformBuiltImage(image: string): boolean {
  const [host, project, repo] = image.trim().toLowerCase().split('/');
  if (!repo) return false;
  return (
    platformRegistryHosts().includes(host) &&
    project === (process.env.REGISTRY_PROJECT || 'orchard').toLowerCase()
  );
}

export function pinToBuildArch(
  affinity: k8s.V1Affinity | undefined,
  image: string
): k8s.V1Affinity | undefined {
  if (!PIN_WORKLOADS_TO_BUILD_ARCH || !isPlatformBuiltImage(image)) return affinity;
  const archExpr: k8s.V1NodeSelectorRequirement = {
    key: ARCH_NODE_LABEL,
    operator: 'In',
    values: [BUILD_ARCH]
  };
  const required = affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  const terms = required?.nodeSelectorTerms?.length ? required.nodeSelectorTerms : [{}];
  return {
    ...affinity,
    nodeAffinity: {
      ...affinity?.nodeAffinity,
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: terms.map((term) => ({
          ...term,
          matchExpressions: [
            ...(term.matchExpressions ?? []).filter((e) => e.key !== ARCH_NODE_LABEL),
            archExpr
          ]
        }))
      }
    }
  };
}
