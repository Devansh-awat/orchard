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

export interface Tombstone {
  uid: string;
  manifest: any;
}

export interface EngineStore {
  listStart(): Promise<string>;
  load(shard: string, kind: string): Promise<StoredRow[]>;
  write(rows: EngineRow[], since?: string): Promise<void>;
  current(entries: { uid: string; resourceVersion: string }[]): Promise<Set<string>>;
  markDerived(
    entries: { uid: string; resourceVersion: string; derivedVersion: string }[]
  ): Promise<void>;
  bury(
    shard: string,
    kind: string,
    obj: { uid: string; manifest: unknown },
    keepTombstone: boolean
  ): Promise<void>;
  buryMissing(
    shard: string,
    kind: string,
    seenUids: string[],
    keepTombstones: boolean,
    retryAfterMs: number,
    since: string
  ): Promise<Tombstone[]>;
  forget(uid: string): Promise<void>;
}

export function sameRefs(a: EngineRefs, b: EngineRefs): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}
