import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  imageRepoFilters,
  isLoopbackHost,
  parseImageRef,
  repositoryName,
  sameRegistryHost,
  type ImageRef
} from './image-ref';

function platformRegistryHosts(): string[] {
  return [process.env.DOCKER_REGISTRY_PULL, process.env.DOCKER_REGISTRY_PUSH].filter(
    (h): h is string => Boolean(h)
  );
}

function onPlatformHost(ref: ImageRef): boolean {
  return (
    ref.host !== null && platformRegistryHosts().some((host) => sameRegistryHost(ref.host!, host))
  );
}

function registryProject(): string {
  return process.env.REGISTRY_PROJECT || 'orchard';
}

export function newImageTag(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
  return `v${stamp}-${randomBytes(6).toString('hex')}`;
}

function assertRegistryAllowed(image: string): void {
  const refuse = () => new ForbiddenException('That image belongs to another project');
  const ref = parseImageRef(image);
  if (!ref) throw refuse();
  if (ref.host && isLoopbackHost(ref.host)) throw refuse();
  if (!onPlatformHost(ref)) return;
  const parts = ref.repository.split('/');
  if (parts.length !== 2 || parts[0] !== registryProject()) throw refuse();
}

export function platformImageRepo(image: string): string | null {
  const ref = parseImageRef(image);
  if (!ref || !onPlatformHost(ref)) return null;
  const [project, repo] = ref.repository.split('/');
  if (project !== registryProject()) return null;
  return repo ?? '';
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
      where: {
        projectId: { not: project.id },
        OR: imageRepoFilters(repo).map((image) => ({ image }))
      },
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
        ...imageRepoFilters(`${namespace}-${name}`).map((image) => ({ image }))
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

export function isPlatformGeneratedName(name: string): boolean {
  return name.includes('--') || /-pub-[tu]\d+$/.test(name) || name.endsWith('-allow-public');
}

export async function assertIngressNameFree(
  prisma: Pick<PrismaService, 'deployment'>,
  namespace: string,
  name: string,
  projectId: string
): Promise<void> {
  const reserved =
    `${namespace}-${name}`.endsWith('-orchard-protection-proxy') || isPlatformGeneratedName(name);
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

function repoOf(image: string): string | null {
  const ref = parseImageRef(image);
  return ref ? repositoryName(ref) : null;
}

export async function splitRegistryCleanup(
  prisma: Pick<PrismaService, 'deployment'>,
  deploymentId: string,
  images: string[],
  ownerNamespace?: string
): Promise<{ repositories: string[]; tags: string[] }> {
  const repositories: string[] = [];
  const tags: string[] = [];
  const shared = new Map<string, boolean>();
  for (const image of images) {
    const repo = repoOf(image);
    if (!repo) continue;
    if (ownerNamespace !== undefined && !repo.startsWith(`${ownerNamespace}-`)) continue;
    if (!shared.has(repo)) {
      const filters = imageRepoFilters(repo);
      const other = await prisma.deployment.findFirst({
        where: {
          id: { not: deploymentId },
          OR: [
            ...filters.map((image) => ({ image })),
            { imageHistory: { some: { OR: filters.map((image) => ({ image })) } } }
          ]
        },
        select: { id: true }
      });
      shared.set(repo, Boolean(other));
    }
    (shared.get(repo) ? tags : repositories).push(image);
  }
  return { repositories, tags };
}
