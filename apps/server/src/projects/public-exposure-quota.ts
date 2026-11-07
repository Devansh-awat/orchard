import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

export const DEFAULT_MAX_PUBLIC_PORTS_PER_ORG = 20;

export function maxPublicPortsPerOrg(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MAX_PUBLIC_PORTS_PER_ORG);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_PUBLIC_PORTS_PER_ORG;
}

export function nodePortExposureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TENANT_NODEPORT_EXPOSURE?.trim().toLowerCase() !== 'false';
}

export function assertWithinPublicPortLimit(used: number, limit = maxPublicPortsPerOrg()): void {
  if (limit > 0 && used >= limit) {
    throw new BadRequestException(
      `This organization already exposes ${used} public ports (limit ${limit}). Close one before opening another.`
    );
  }
}

export async function assertOrgCanExposePublicPort(
  prisma: PrismaService,
  organizationId: string
): Promise<void> {
  const limit = maxPublicPortsPerOrg();
  if (limit === 0) return;
  const [external, published, databases] = await Promise.all([
    prisma.service.count({
      where: { type: 'external', deployment: { project: { organizationId } } }
    }),
    prisma.servicePort.count({
      where: {
        publicEnabled: true,
        service: { deployment: { project: { organizationId } } }
      }
    }),
    prisma.database.count({ where: { publicEnabled: true, project: { organizationId } } })
  ]);
  assertWithinPublicPortLimit(external + published + databases, limit);
}

export async function assertOrgCanExposeNodePort(
  prisma: PrismaService,
  organizationId: string
): Promise<void> {
  if (!nodePortExposureEnabled()) {
    throw new BadRequestException(
      'Exposing a raw node port is disabled on this instance. Use a public port on the organization public IP instead.'
    );
  }
  await assertOrgCanExposePublicPort(prisma, organizationId);
}
