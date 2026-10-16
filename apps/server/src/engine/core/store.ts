export type EngineRefs = Record<string, string | null | undefined>;

export interface EngineRow {
  uid: string;
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  resourceVersion: string;
  derivedVersion: string | null;
  shard: string;
  manifest: unknown;
  refs: EngineRefs;
}

export interface StoredRow {
  uid: string;
  resourceVersion: string;
  derivedVersion: string | null;
  refs: EngineRefs;
}

export interface RemovedRow {
  uid: string;
  manifest: any;
}

export interface EngineStore {
  load(shard: string, kind: string): Promise<StoredRow[]>;
  write(rows: EngineRow[]): Promise<void>;
  markDerived(entries: { uid: string; resourceVersion: string }[]): Promise<void>;
  remove(uid: string): Promise<void>;
  sweep(shard: string, kind: string, seenUids: string[]): Promise<RemovedRow[]>;
}

export function sameRefs(a: EngineRefs, b: EngineRefs): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}
