export const BUILD_CACHE_SETTINGS_KEY = 'build_cache';

export const BUILD_CACHE_MAX_GIB_LIMIT = 10_000;

export const BUILD_CACHE_MAX_AGE_LIMIT = 365;

export interface BuildCacheSettings {
  enabled: boolean;
  maxGiB: number | null;
  maxAgeDays: number;
}

export type PruneMode = 'idle' | 'all';

function positiveInt(raw: unknown, max: number): number | null {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1 && value <= max ? value : null;
}

export function defaultBuildCacheSettings(
  env: Record<string, string | undefined> = process.env
): BuildCacheSettings {
  return {
    enabled: true,
    maxGiB: positiveInt(env.BUILDKIT_CACHE_MAX_GIB, BUILD_CACHE_MAX_GIB_LIMIT),
    maxAgeDays: positiveInt(env.BUILDKIT_CACHE_MAX_AGE_DAYS, BUILD_CACHE_MAX_AGE_LIMIT) ?? 14
  };
}

export function parseStoredBuildCacheSettings(
  raw: string | null,
  defaults: BuildCacheSettings
): BuildCacheSettings {
  if (!raw) return defaults;
  let stored: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    stored = parsed as Record<string, unknown>;
  } catch {
    return defaults;
  }
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : defaults.enabled,
    maxGiB:
      stored.maxGiB === null
        ? null
        : (positiveInt(stored.maxGiB, BUILD_CACHE_MAX_GIB_LIMIT) ?? defaults.maxGiB),
    maxAgeDays: positiveInt(stored.maxAgeDays, BUILD_CACHE_MAX_AGE_LIMIT) ?? defaults.maxAgeDays
  };
}

export function applyBuildCachePatch(
  current: BuildCacheSettings,
  body: unknown
): BuildCacheSettings {
  if (!body || typeof body !== 'object') throw new Error('Send the settings to change');
  const patch = body as Record<string, unknown>;
  const next = { ...current };
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be true or false');
    next.enabled = patch.enabled;
  }
  if ('maxGiB' in patch) {
    if (patch.maxGiB === null) {
      next.maxGiB = null;
    } else {
      const value = positiveInt(patch.maxGiB, BUILD_CACHE_MAX_GIB_LIMIT);
      if (value === null) {
        throw new Error(
          `maxGiB must be a whole number of GiB from 1 to ${BUILD_CACHE_MAX_GIB_LIMIT}, or null for no limit`
        );
      }
      next.maxGiB = value;
    }
  }
  if ('maxAgeDays' in patch) {
    const value = positiveInt(patch.maxAgeDays, BUILD_CACHE_MAX_AGE_LIMIT);
    if (value === null) {
      throw new Error(
        `maxAgeDays must be a whole number of days from 1 to ${BUILD_CACHE_MAX_AGE_LIMIT}`
      );
    }
    next.maxAgeDays = value;
  }
  return next;
}

export function tenantOfSubPath(subPath: string | undefined): string | null {
  const first = (subPath ?? '').split('/').find((part) => part.length > 0);
  return first && first !== '.' && first !== '..' ? first : null;
}

const SAFE_TENANT = /^[a-zA-Z0-9._-]+$/;

export function cacheUsageScript(): string {
  return `set -u
CACHE_ROOT="/cache"
if stat -c%Y "$CACHE_ROOT" >/dev/null 2>&1; then STAT_FMT=-c%Y; else STAT_FMT=-f%m; fi
for dir in "$CACHE_ROOT"/*/; do
  [ -d "$dir" ] || continue
  name=\${dir#"$CACHE_ROOT"/}
  name=\${name%/}
  kb=$(du -sk "$dir" 2>/dev/null | awk '{print $1+0}')
  newest=$(find "$dir" -maxdepth 2 -exec stat $STAT_FMT {} + 2>/dev/null | sort -rn | head -1)
  echo "TENANT \${kb:-0} \${newest:-0} $name"
done
echo "TOTAL $(du -sk "$CACHE_ROOT" 2>/dev/null | awk '{print $1+0}')"
echo "DISK $(df -Pk "$CACHE_ROOT" 2>/dev/null | awk 'NR==2 {print $2+0, $3+0}')"
`;
}

export function cachePruneScript(opts: {
  mode: PruneMode;
  idleMinutes: number;
  keep: string[];
}): string {
  const keep = opts.keep.filter((name) => SAFE_TENANT.test(name));
  return `set -u
CACHE_ROOT="/cache"
KEEP=" ${keep.join(' ')} "
MODE="${opts.mode}"
IDLE_CUTOFF=$(( $(date +%s) - ${Math.max(0, Math.floor(opts.idleMinutes))} * 60 ))
if stat -c%Y "$CACHE_ROOT" >/dev/null 2>&1; then STAT_FMT=-c%Y; else STAT_FMT=-f%m; fi
BEFORE=$(du -sk "$CACHE_ROOT" 2>/dev/null | awk '{print $1+0}')
for dir in "$CACHE_ROOT"/*/; do
  [ -d "$dir" ] || continue
  name=\${dir#"$CACHE_ROOT"/}
  name=\${name%/}
  case "$KEEP" in *" $name "*) echo "SKIP $name in-use"; continue ;; esac
  if [ "$MODE" = idle ]; then
    newest=$(find "$dir" -maxdepth 2 -exec stat $STAT_FMT {} + 2>/dev/null | sort -rn | head -1)
    if [ -z "$newest" ] || [ "$newest" -gt "$IDLE_CUTOFF" ]; then
      echo "SKIP $name recent"
      continue
    fi
  fi
  rm -rf "\${CACHE_ROOT:?}/$name" && echo "REMOVED $name"
done
AFTER=$(du -sk "$CACHE_ROOT" 2>/dev/null | awk '{print $1+0}')
echo "BEFORE $BEFORE"
echo "AFTER $AFTER"
`;
}

export interface CacheTenantUsage {
  name: string;
  bytes: number;
  lastUsedAt: string | null;
}

export interface CacheUsage {
  totalBytes: number;
  diskBytes: number | null;
  diskUsedBytes: number | null;
  tenants: CacheTenantUsage[];
}

export function parseCacheUsage(log: string): CacheUsage {
  const tenants: CacheTenantUsage[] = [];
  let totalBytes = 0;
  let diskBytes: number | null = null;
  let diskUsedBytes: number | null = null;
  for (const line of log.split('\n')) {
    const tenant = /^TENANT (\d+) (\d+) (\S+)$/.exec(line.trim());
    if (tenant) {
      const seconds = Number(tenant[2]);
      tenants.push({
        name: tenant[3],
        bytes: Number(tenant[1]) * 1024,
        lastUsedAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : null
      });
      continue;
    }
    const total = /^TOTAL (\d+)$/.exec(line.trim());
    if (total) {
      totalBytes = Number(total[1]) * 1024;
      continue;
    }
    const disk = /^DISK (\d+) (\d+)$/.exec(line.trim());
    if (disk) {
      diskBytes = Number(disk[1]) * 1024;
      diskUsedBytes = Number(disk[2]) * 1024;
    }
  }
  tenants.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes, diskBytes, diskUsedBytes, tenants };
}

export interface CachePruneResult {
  freedBytes: number;
  totalBytes: number;
  removed: string[];
  skipped: { name: string; reason: 'in-use' | 'recent' }[];
}

export function parseCachePrune(log: string): CachePruneResult {
  let before = 0;
  let after = 0;
  const removed: string[] = [];
  const skipped: CachePruneResult['skipped'] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    const removedMatch = /^REMOVED (\S+)$/.exec(line);
    if (removedMatch) removed.push(removedMatch[1]);
    const skipMatch = /^SKIP (\S+) (in-use|recent)$/.exec(line);
    if (skipMatch)
      skipped.push({ name: skipMatch[1], reason: skipMatch[2] as 'in-use' | 'recent' });
    const beforeMatch = /^BEFORE (\d+)$/.exec(line);
    if (beforeMatch) before = Number(beforeMatch[1]) * 1024;
    const afterMatch = /^AFTER (\d+)$/.exec(line);
    if (afterMatch) after = Number(afterMatch[1]) * 1024;
  }
  return { freedBytes: Math.max(0, before - after), totalBytes: after, removed, skipped };
}

export const NEXT_CACHE_SUFFIX = '.next';

export const cacheSwapScript = `if [ "$BUILD_EXIT_CODE" -eq 0 ] && [ -n "$CACHE_ARGS" ] && [ -f "$CACHE_DIR${NEXT_CACHE_SUFFIX}/index.json" ]; then
  rm -rf "$CACHE_DIR" && mv "$CACHE_DIR${NEXT_CACHE_SUFFIX}" "$CACHE_DIR" && echo "=== Build cache replaced with this build's layers ==="
fi
rm -rf "$CACHE_DIR${NEXT_CACHE_SUFFIX}" 2>/dev/null || true
`;
