import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { isDatabaseImage } from '../kubernetes/presets';
import { parseCpu, parseMemory } from '../kubernetes/quantity';
import { formatSlug } from '../projects/projects.utils';

const MAX_CLAIM_LENGTH = 63;
const MiB = 1024 * 1024;

const CPU_QUANTITY = /^\d+(\.\d+)?m?$/;
const MEMORY_QUANTITY = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|K|M|G|T)$/;

const APP_DEFAULT = { cpuMilli: 500, memoryBytes: 512 * MiB };
const DATABASE_DEFAULT = { cpuMilli: 500, memoryBytes: 1024 * MiB };

export interface PodSize {
  cpuMilli: number;
  memoryBytes: number;
}

export interface PodSizeOverride {
  cpuRequestMilli?: number | null;
  memoryRequestBytes?: number | null;
}

export function recommendedPodSize(
  resourceName: string,
  type: string,
  config: Record<string, any>
): PodSize {
  const fallback =
    type === 'database' || isDatabaseImage(config?.image) ? DATABASE_DEFAULT : APP_DEFAULT;
  const raw = config?.resources;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException(
      `Resource "${resourceName}" has invalid resources: expected cpu and memory`
    );
  }
  return {
    cpuMilli:
      parseQuantity(resourceName, 'cpu', raw.cpu, CPU_QUANTITY, parseCpu) ?? fallback.cpuMilli,
    memoryBytes:
      parseQuantity(resourceName, 'memory', raw.memory, MEMORY_QUANTITY, parseMemory) ??
      fallback.memoryBytes
  };
}

function parseQuantity(
  resourceName: string,
  field: 'cpu' | 'memory',
  value: unknown,
  pattern: RegExp,
  parse: (text: string) => number
): number | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const parsed = pattern.test(text) ? parse(text) : 0;
  if (parsed <= 0) {
    throw new BadRequestException(
      `Resource "${resourceName}" has invalid ${field} "${text}". Use a size like 500m or 1Gi`
    );
  }
  return parsed;
}

function chosen(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestException(`${label} must be a positive number`);
  }
  return amount;
}

export function chosenPodSize(
  recommended: PodSize,
  everyResource?: PodSizeOverride | null,
  thisResource?: PodSizeOverride | null
): { cpuRequestMilli: number; memoryRequestBytes: number } {
  return {
    cpuRequestMilli:
      chosen(thisResource?.cpuRequestMilli, 'CPU') ??
      chosen(everyResource?.cpuRequestMilli, 'CPU') ??
      recommended.cpuMilli,
    memoryRequestBytes:
      chosen(thisResource?.memoryRequestBytes, 'Memory') ??
      chosen(everyResource?.memoryRequestBytes, 'Memory') ??
      recommended.memoryBytes
  };
}

export function isolateTemplateVolumes<T>(deploymentName: string, volumes: T): T {
  if (!Array.isArray(volumes)) return volumes;
  return volumes.map((vol) => {
    if (!vol || vol.type !== 'pvc') return vol;
    const suffix = randomBytes(3).toString('hex');
    const prefix = formatSlug(`${deploymentName}-${vol.name}`)
      .slice(0, MAX_CLAIM_LENGTH - suffix.length - 1)
      .replace(/-+$/, '');
    return { ...vol, pvcName: `${prefix}-${suffix}` };
  }) as T;
}
