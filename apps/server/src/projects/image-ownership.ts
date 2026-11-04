import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:443$/, '');
}

function platformRegistryHosts(): string[] {
  return [process.env.DOCKER_REGISTRY_PULL, process.env.DOCKER_REGISTRY_PUSH]
    .filter((h): h is string => Boolean(h))
    .map(normalizeHost);
}

export function platformImageRepo(image: string): string | null {
  const [host, ...rest] = image.toLowerCase().split('/');
  if (!platformRegistryHosts().includes(normalizeHost(host))) return null;
  const [registryProject, repo] = rest;
  if (registryProject !== (process.env.REGISTRY_PROJECT || 'orchard')) return null;
  return (repo ?? '').split(/[:@]/)[0];
}

export async function assertImageOwnedByProject(
  prisma: Pick<PrismaService, 'project' | 'environment'>,
  image: string,
  project: { id: string; namespace: string }
): Promise<void> {
  const repo = platformImageRepo(image);
  if (repo === null) return;
  const refuse = () => new ForbiddenException('That image belongs to another project');
  if (!repo.startsWith(`${project.namespace}-`)) throw refuse();

  const longer = { startsWith: `${project.namespace}-` };
  const [projects, environments] = await Promise.all([
    prisma.project.findMany({
      where: { namespace: longer, id: { not: project.id } },
      select: { namespace: true }
    }),
    prisma.environment.findMany({
      where: { namespace: longer, projectId: { not: project.id } },
      select: { namespace: true }
    })
  ]);
  const claimed = [...projects, ...environments].some((other) =>
    repo.startsWith(`${other.namespace}-`)
  );
  if (claimed) throw refuse();
}
