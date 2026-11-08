import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { parseCpu, parseMemory } from '../kubernetes/quantity';

export const DEFAULT_MAX_PROJECTS_PER_ORG = 500;
export const DEFAULT_MAX_ENVIRONMENTS_PER_ORG = 1000;
export const DEFAULT_MAX_DEPLOYMENTS_PER_ORG = 2000;
export const DEFAULT_NEW_ORG_CPU = '16';
export const DEFAULT_NEW_ORG_MEMORY = '32Gi';

export type OrgCountKind = 'projects' | 'environments' | 'deployments';

export interface OrgCountLimits {
  projects: number;
  environments: number;
  deployments: number;
}

export interface NewOrgCaps {
  cpuLimitMilli: number | null;
  memoryLimitBytes: bigint | null;
}

function countLimit(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  return raw?.trim() && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function orgCountLimits(env: NodeJS.ProcessEnv = process.env): OrgCountLimits {
  return {
    projects: countLimit(env.MAX_PROJECTS_PER_ORG, DEFAULT_MAX_PROJECTS_PER_ORG),
    environments: countLimit(env.MAX_ENVIRONMENTS_PER_ORG, DEFAULT_MAX_ENVIRONMENTS_PER_ORG),
    deployments: countLimit(env.MAX_DEPLOYMENTS_PER_ORG, DEFAULT_MAX_DEPLOYMENTS_PER_ORG)
  };
}

function quantityOrNull(
  raw: string | undefined,
  fallback: string,
  parse: (value: string) => number
): number | null {
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();
  if (value === '0' || value.toLowerCase() === 'unlimited') return null;
  const parsed = parse(value);
  return parsed > 0 ? parsed : null;
}

export function newOrgCaps(env: NodeJS.ProcessEnv = process.env): NewOrgCaps {
  const memory = quantityOrNull(env.NEW_ORG_MEMORY, DEFAULT_NEW_ORG_MEMORY, parseMemory);
  return {
    cpuLimitMilli: quantityOrNull(env.NEW_ORG_CPU, DEFAULT_NEW_ORG_CPU, parseCpu),
    memoryLimitBytes: memory === null ? null : BigInt(memory)
  };
}

const LABELS: Record<OrgCountKind, string> = {
  projects: 'projects',
  environments: 'extra environments',
  deployments: 'deployments'
};

export function assertWithinOrgCount(kind: OrgCountKind, used: number, limit: number): void {
  if (limit > 0 && used >= limit) {
    throw new ForbiddenException(
      `This organization already has ${used} ${LABELS[kind]} (limit ${limit}). Remove some or ask an administrator to raise the limit.`
    );
  }
}

export async function assertOrgCanCreate(
  prisma: PrismaService,
  organizationId: string,
  kind: OrgCountKind,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const limit = orgCountLimits(env)[kind];
  if (limit === 0) return;
  const used =
    kind === 'projects'
      ? await prisma.project.count({ where: { organizationId } })
      : kind === 'environments'
        ? await prisma.environment.count({
            where: { isDefault: false, project: { organizationId } }
          })
        : await prisma.deployment.count({ where: { project: { organizationId } } });
  assertWithinOrgCount(kind, used, limit);
}
