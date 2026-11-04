import { ConflictException, ForbiddenException } from '@nestjs/common';
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

export async function assertIngressNameFree(
  prisma: Pick<PrismaService, 'deployment'>,
  namespace: string,
  name: string,
  projectId: string
): Promise<void> {
  const full = `${namespace}-${name}`;
  const splits: { namespace: string; name: string }[] = [];
  for (let i = full.indexOf('-'); i !== -1; i = full.indexOf('-', i + 1)) {
    splits.push({ namespace: full.slice(0, i), name: full.slice(i + 1) });
  }
  const taken = await prisma.deployment.findFirst({
    where: { projectId: { not: projectId }, OR: splits },
    select: { id: true }
  });
  if (taken) {
    throw new ConflictException(
      'This app name clashes with an app in another project. Choose a different name.'
    );
  }
}
