import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GRAFT_SDK_VERSION = '1.0.0';

export type DoorStatus = { version: number; status: 'stable' | 'deprecated'; removeIn?: string };

export const GRAFT_DOORS: Record<string, DoorStatus[]> = {};

export function platformVersion(): string {
  return (
    JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    }
  ).version;
}

export function missingDoors(uses: Record<string, number>): string[] {
  return Object.entries(uses)
    .filter(([door, version]) => !(GRAFT_DOORS[door] ?? []).some((d) => d.version === version))
    .map(([door, version]) => `${door}@${version}`);
}

export function deprecatedDoors(uses: Record<string, number>): string[] {
  return Object.entries(uses)
    .map(([door, version]) => ({
      door,
      entry: (GRAFT_DOORS[door] ?? []).find((d) => d.version === version)
    }))
    .filter(({ entry }) => entry?.status === 'deprecated')
    .map(
      ({ door, entry }) =>
        `${door}@${entry!.version}${entry!.removeIn ? ` (removed in ${entry!.removeIn})` : ''}`
    );
}
