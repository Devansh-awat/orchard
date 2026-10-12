import { canUseName, type ClaimKind } from '../claims';
import { ownerOf, type GraftRecord } from '../graft-registry';
import type { GraftCapability } from '../manifest';

export type DoorMeta = {
  name: string;
  version: number;
  status: 'stable' | 'deprecated';
  removeIn?: string;
  capability?: GraftCapability;
};

export function doorToken(name: string, version: number): symbol {
  return Symbol.for(`orchard.graft.door.${name}@${version}`);
}

export function bindGraft(parent: unknown, meta: DoorMeta): GraftRecord {
  const record = ownerOf(parent);
  if (!record?.manifest) {
    throw new Error(`door ${meta.name}@${meta.version} can only be injected into graft code`);
  }
  if (meta.capability && !record.manifest.capabilities.includes(meta.capability)) {
    throw new Error(
      `graft ${record.id} injects door ${meta.name}@${meta.version} but its graft.json does not declare the "${meta.capability}" capability`
    );
  }
  return record;
}

export function assertClaimed(
  record: GraftRecord,
  kind: ClaimKind,
  name: string,
  what: string
): void {
  if (!canUseName(record.id, record.claims, kind, name)) {
    throw new Error(
      `graft ${record.id} used ${what} "${name}", which is neither under "${record.id}." nor an active ${kind} claim`
    );
  }
}
