import type { RepoConfigDetection } from '../github/github.service';

type EnvEntry = { key: string; value: string; secret?: boolean };

export interface DetectedBuild {
  buildType: 'dockerfile' | 'railpack';
  dockerfilePath?: string;
  port?: number;
  env: EnvEntry[];
  rootDirectory?: string;
  framework?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
}

/**
 * What a create request that named no build should use, given a detection run.
 * A Railpack app reads its port from PORT, so that has to follow the chosen port,
 * while a Dockerfile's ENV is already in the image. The caller's env always wins.
 */
export function detectedBuildFor(
  det: RepoConfigDetection,
  given: { port?: number; declaresPorts?: boolean; env?: EnvEntry[] }
): DetectedBuild {
  const env = [...(given.env ?? [])];
  const port = given.port ?? (given.declaresPorts ? undefined : det.ports[0]);
  if (det.buildType === 'dockerfile') {
    return { buildType: 'dockerfile', dockerfilePath: det.dockerfilePath ?? undefined, port, env };
  }
  if (port && !env.some((entry) => entry.key === 'PORT')) {
    env.push({ key: 'PORT', value: String(port) });
  }
  return {
    buildType: 'railpack',
    port,
    env,
    rootDirectory: det.rootDirectory ?? undefined,
    framework: det.framework ?? undefined,
    installCommand: det.installCommand ?? undefined,
    buildCommand: det.buildCommand ?? undefined,
    outputDirectory: det.outputDirectory ?? undefined,
    startCommand: det.outputDirectory ? undefined : (det.startCommand ?? undefined)
  };
}
