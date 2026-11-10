import { BadRequestException } from '@nestjs/common';
import { parseMemory } from './quantity';
import { resolveLimit } from '../quotas/instance-limits';

export const DEFAULT_MAX_VOLUME_SIZE = '200Gi';

export const MIN_VOLUME_SIZE = '100Mi';

const VOLUME_QUANTITY = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|K|M|G|T)?$/;

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function maxVolumeSize(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.MAX_VOLUME_SIZE?.trim();
  if (configured) return VOLUME_QUANTITY.test(configured) ? configured : DEFAULT_MAX_VOLUME_SIZE;
  const limit = resolveLimit('volumeSizeGiB', env);
  return typeof limit === 'number' ? `${limit}Gi` : null;
}

export function maxVolumeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const size = maxVolumeSize(env);
  return size === null ? Number.POSITIVE_INFINITY : parseMemory(size);
}

export function assertVolumeQuantity(size: unknown): string {
  const value = typeof size === 'string' ? size.trim() : '';
  if (!VOLUME_QUANTITY.test(value)) {
    throw new BadRequestException(
      `Storage size "${String(size ?? '')}" isn't valid. Use a size like 1Gi or 500Mi.`
    );
  }
  return value;
}

export function assertValidVolumeSize(size: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const value = assertVolumeQuantity(size);
  const bytes = parseMemory(value);
  if (bytes < parseMemory(MIN_VOLUME_SIZE)) {
    throw new BadRequestException(`Storage size can't be below ${MIN_VOLUME_SIZE}`);
  }
  if (bytes > maxVolumeBytes(env)) {
    throw new BadRequestException(`Storage size can't exceed ${maxVolumeSize(env)}`);
  }
  return value;
}

export function assertValidClaimName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!DNS1123_LABEL.test(value) || value.length > 63) {
    throw new BadRequestException(
      `Volume name "${String(name ?? '')}" must be 1-63 lowercase letters, numbers, or hyphens`
    );
  }
  return value;
}

export function isPlatformOwnedClaim(labels: Record<string, string> | null | undefined): boolean {
  if (!labels) return false;
  return Object.keys(labels).some((key) => key.startsWith('cnpg.io/'));
}
