import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:443$/, '');
}

function platformRegistryHosts(): string[] {
  return [process.env.DOCKER_REGISTRY_PULL, process.env.DOCKER_REGISTRY_PUSH]
    .filter((h): h is string => Boolean(h))
    .map(normalizeHost);
}

const LOOPBACK_HOST = /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)(:\d+)?$/;

export function newImageTag(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
  return `v${stamp}-${randomBytes(6).toString('hex')}`;
}

function assertRegistryAllowed(image: string): void {
  const [host, ...rest] = image.toLowerCase().split('/');
  const refuse = () => new ForbiddenException('That image belongs to another project');
  if (LOOPBACK_HOST.test(host)) throw refuse();
  if (!platformRegistryHosts().includes(normalizeHost(host))) return;
  if (rest.length !== 2 || rest[0] !== (process.env.REGISTRY_PROJECT || 'orchard')) throw refuse();
}

export function platformImageRepo(image: string): string | null {
  const [host, ...rest] = image.toLowerCase().split('/');
  if (!platformRegistryHosts().includes(normalizeHost(host))) return null;
  const [registryProject, repo] = rest;
  if (registryProject !== (process.env.REGISTRY_PROJECT || 'orchard')) return null;
  return (repo ?? '').split(/[:@]/)[0];
}

export async function assertImageOwnedByProject(
  prisma: Pick<PrismaService, 'project' | 'environment' | 'deployment'>,
  image: string,
  project: { id: string; namespace: string }
): Promise<void> {
  assertRegistryAllowed(image);
  const repo = platformImageRepo(image);
  if (repo === null) return;
  const refuse = () => new ForbiddenException('That image belongs to another project');
  if (!repo.startsWith(`${project.namespace}-`)) throw refuse();

  const longer = { startsWith: `${project.namespace}-` };
  const [projects, environments, taken] = await Promise.all([
    prisma.project.findMany({
      where: { namespace: longer, id: { not: project.id } },
      select: { namespace: true }
    }),
    prisma.environment.findMany({
      where: { namespace: longer, projectId: { not: project.id } },
      select: { namespace: true }
    }),
    prisma.deployment.findFirst({
      where: { projectId: { not: project.id }, image: { contains: `/${repo}:` } },
      select: { id: true }
    })
  ]);
  if (taken) throw refuse();
  const claimed = [...projects, ...environments].some((other) =>
    repo.startsWith(`${other.namespace}-`)
  );
  if (claimed) throw refuse();
}

function nameSplits(namespace: string, name: string): { namespace: string; name: string }[] {
  const full = `${namespace}-${name}`;
  const splits: { namespace: string; name: string }[] = [];
  for (let i = full.indexOf('-'); i !== -1; i = full.indexOf('-', i + 1)) {
    splits.push({ namespace: full.slice(0, i), name: full.slice(i + 1) });
  }
  return splits;
}

export async function assertRepoNameFree(
  prisma: Pick<PrismaService, 'deployment'>,
  namespace: string,
  name: string,
  projectId: string
): Promise<void> {
  const taken = await prisma.deployment.findFirst({
    where: {
      projectId: { not: projectId },
      OR: [
        ...nameSplits(namespace, name).map((split) => ({
          name: split.name,
          project: { namespace: split.namespace }
        })),
        { image: { contains: `/${namespace}-${name}:` } }
      ]
    },
    select: { id: true }
  });
  if (taken) {
    throw new ConflictException(
      'This app name clashes with an app in another project. Choose a different name.'
    );
  }
}

export async function assertIngressNameFree(
  prisma: Pick<PrismaService, 'deployment'>,
  namespace: string,
  name: string,
  projectId: string
): Promise<void> {
  const reserved = `${namespace}-${name}`.endsWith('-orchard-protection-proxy');
  const taken =
    reserved ||
    (await prisma.deployment.findFirst({
      where: {
        projectId: { not: projectId },
        OR: nameSplits(namespace, name).map((split) => ({
          namespace: split.namespace,
          OR: [{ name: split.name }, { services: { some: { name: split.name } } }]
        }))
      },
      select: { id: true }
    }));
  if (taken) {
    throw new ConflictException(
      'This app name clashes with an app in another project. Choose a different name.'
    );
  }
}

function repoOf(image: string): string {
  return (image.split('/').pop() ?? image).split(/[:@]/)[0];
}

export async function splitRegistryCleanup(
  prisma: Pick<PrismaService, 'deployment'>,
  deploymentId: string,
  images: string[]
): Promise<{ repositories: string[]; tags: string[] }> {
  const repositories: string[] = [];
  const tags: string[] = [];
  const shared = new Map<string, boolean>();
  for (const image of images) {
    const repo = repoOf(image);
    if (!shared.has(repo)) {
      const contains = `/${repo}:`;
      const other = await prisma.deployment.findFirst({
        where: {
          id: { not: deploymentId },
          OR: [{ image: { contains } }, { imageHistory: { some: { image: { contains } } } }]
        },
        select: { id: true }
      });
      shared.set(repo, Boolean(other));
    }
    (shared.get(repo) ? tags : repositories).push(image);
  }
  return { repositories, tags };
}
