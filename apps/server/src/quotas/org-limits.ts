import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { parseCpu, parseMemory } from '../kubernetes/quantity';

export type OrgCountKind = 'projects' | 'environments' | 'deployments';

/** Caps handed to a new organization. Null on any axis means uncapped. */
export interface NewOrgDefaults {
  cpuLimitMilli: number | null;
  memoryLimitBytes: number | null;
  maxProjects: number | null;
  maxEnvironments: number | null;
  maxDeployments: number | null;
}

/** The same caps shaped for `organization.create`. */
export interface NewOrgCaps {
  cpuLimitMilli: number | null;
  memoryLimitBytes: bigint | null;
  maxProjects: number | null;
  maxEnvironments: number | null;
  maxDeployments: number | null;
}

export const NEW_ORG_DEFAULT_FIELDS = [
  'cpuLimitMilli',
  'memoryLimitBytes',
  'maxProjects',
  'maxEnvironments',
  'maxDeployments'
] as const satisfies readonly (keyof NewOrgDefaults)[];

export const UNCAPPED_NEW_ORG: NewOrgDefaults = {
  cpuLimitMilli: null,
  memoryLimitBytes: null,
  maxProjects: null,
  maxEnvironments: null,
  maxDeployments: null
};

function quantityOrNull(raw: string | undefined, parse: (value: string) => number): number | null {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '0' || value.toLowerCase() === 'unlimited') return null;
  const parsed = parse(value);
  return parsed > 0 ? parsed : null;
}

/**
 * What a new organization gets when no instance default has been stored: nothing,
 * unless the operator seeded NEW_ORG_CPU / NEW_ORG_MEMORY. Counts are never seeded
 * from the environment.
 */
export function envNewOrgDefaults(env: NodeJS.ProcessEnv = process.env): NewOrgDefaults {
  return {
    ...UNCAPPED_NEW_ORG,
    cpuLimitMilli: quantityOrNull(env.NEW_ORG_CPU, parseCpu),
    memoryLimitBytes: quantityOrNull(env.NEW_ORG_MEMORY, parseMemory)
  };
}

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Read the stored JSON; anything malformed degrades to uncapped on that axis. */
export function parseNewOrgDefaults(raw: string | null | undefined): NewOrgDefaults | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      NEW_ORG_DEFAULT_FIELDS.map((field) => [field, positiveIntOrNull(parsed[field])])
    ) as unknown as NewOrgDefaults;
  } catch {
    return null;
  }
}

const FIELD_LABELS: Record<keyof NewOrgDefaults, string> = {
  cpuLimitMilli: 'CPU cap',
  memoryLimitBytes: 'Memory cap',
  maxProjects: 'Project limit',
  maxEnvironments: 'Environment limit',
  maxDeployments: 'Deployment limit'
};

/** Validate an admin request body. A missing or null field is uncapped. */
export function validateNewOrgDefaults(body: unknown): NewOrgDefaults {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Expected an object of default caps');
  }
  const input = body as Record<string, unknown>;
  const out = { ...UNCAPPED_NEW_ORG };
  for (const field of NEW_ORG_DEFAULT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const parsed = positiveIntOrNull(value);
    if (parsed === null) {
      throw new BadRequestException(
        `${FIELD_LABELS[field]} must be a positive whole number or blank`
      );
    }
    out[field] = parsed;
  }
  return out;
}

export function newOrgCapsData(defaults: NewOrgDefaults): NewOrgCaps {
  return {
    ...defaults,
    memoryLimitBytes: defaults.memoryLimitBytes === null ? null : BigInt(defaults.memoryLimitBytes)
  };
}

/**
 * A hard per-org ceiling an operator can pin in the environment. Unset or 0 means no
 * ceiling; the per-org value on the organization row is what normally applies.
 */
export function orgCountCeilings(
  env: NodeJS.ProcessEnv = process.env
): Record<OrgCountKind, number> {
  const read = (raw: string | undefined) => {
    const parsed = Number(raw?.trim());
    return raw?.trim() && Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    projects: read(env.MAX_PROJECTS_PER_ORG),
    environments: read(env.MAX_ENVIRONMENTS_PER_ORG),
    deployments: read(env.MAX_DEPLOYMENTS_PER_ORG)
  };
}

/** The stricter of the org's own limit and the environment ceiling; 0 = unlimited. */
export function effectiveCountLimit(orgLimit: number | null | undefined, ceiling: number): number {
  const own = orgLimit && orgLimit > 0 ? orgLimit : 0;
  if (own && ceiling) return Math.min(own, ceiling);
  return own || ceiling;
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
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { maxProjects: true, maxEnvironments: true, maxDeployments: true }
  });
  const own =
    kind === 'projects'
      ? org?.maxProjects
      : kind === 'environments'
        ? org?.maxEnvironments
        : org?.maxDeployments;
  const limit = effectiveCountLimit(own, orgCountCeilings(env)[kind]);
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
