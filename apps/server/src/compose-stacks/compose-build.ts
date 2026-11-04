import { BadRequestException } from '@nestjs/common';
import { posix } from 'path';

export interface ComposeBuildPaths {
  dockerfilePath: string;
  buildFromRoot: boolean;
}

const escapesRepo = (path: string) => path === '..' || path.startsWith('../');

/**
 * Compose resolves `context` against the compose file and `dockerfile` against the
 * context, while a deployment holds a path from the repo root. It builds from
 * either the repo root or the Dockerfile's own folder, so a context that is neither
 * is refused here rather than built from the wrong place.
 */
export function composeBuildPaths(
  service: string,
  composePath: string,
  build: { context?: unknown; dockerfile?: unknown }
): ComposeBuildPaths {
  const rawContext = typeof build.context === 'string' ? build.context.trim() : '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawContext) || rawContext.startsWith('git@')) {
    throw new BadRequestException(
      `Service "${service}" builds from ${rawContext}. Orchard builds from a folder in this repository.`
    );
  }
  const context = posix
    .normalize(posix.join(posix.dirname(composePath), rawContext || '.'))
    .replace(/\/+$/, '');
  const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile.trim() : '';
  const dockerfilePath = posix.normalize(posix.join(context, dockerfile || 'Dockerfile'));

  if (rawContext.startsWith('/') || escapesRepo(context) || escapesRepo(dockerfilePath)) {
    throw new BadRequestException(
      `Service "${service}" builds from outside the repository. Use a folder in this repository as its build context.`
    );
  }
  if (context === '.') return { dockerfilePath, buildFromRoot: true };
  if (posix.dirname(dockerfilePath) === context) return { dockerfilePath, buildFromRoot: false };
  throw new BadRequestException(
    `Service "${service}" builds from ${context} with its Dockerfile at ${dockerfilePath}. Orchard builds from the repository root or the Dockerfile's folder, so move the Dockerfile into ${context}.`
  );
}

interface StackChild {
  name: string;
  composeServiceName?: string | null;
  buildStatus?: string | null;
}

/**
 * A stack's build state is its services' build state, read fresh, so a retried
 * build clears the failure on its own. Only a settled stack takes on a failure:
 * `deploying` and `deleting` still describe what is happening right now.
 */
export function stackWithBuildState<
  T extends {
    status: string;
    buildStatus: string;
    lastError: string | null;
    deployments: StackChild[];
  }
>(stack: T): T {
  const builds = stack.deployments.filter((d) => d.buildStatus && d.buildStatus !== 'none');
  if (builds.length === 0) return { ...stack, buildStatus: 'none' };

  const failed = builds.filter((d) => d.buildStatus === 'failed');
  if (failed.length > 0) {
    const names = failed.map((d) => d.composeServiceName ?? d.name).join(', ');
    return stack.status === 'active'
      ? {
          ...stack,
          buildStatus: 'failed',
          status: 'failed',
          lastError: `The build failed for ${names}. Open the service to read its build log.`
        }
      : { ...stack, buildStatus: 'failed' };
  }
  const building = builds.some((d) => d.buildStatus === 'building' || d.buildStatus === 'pending');
  return { ...stack, buildStatus: building ? 'building' : 'succeeded' };
}
