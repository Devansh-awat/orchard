// Shared resource presets. Keep in sync with frontend/src/lib/presets.ts.
import { imageRepo } from './trusted-images';

export interface ResourcePreset {
  id: string;
  label: string;
  description: string;
  cpuMilli: number;
  memoryBytes: number;
}

const MiB = 1024 * 1024;

export const RESOURCE_PRESETS: ResourcePreset[] = [
  {
    id: 'nano',
    label: 'Nano',
    description: 'Cron jobs, hello-worlds',
    cpuMilli: 50,
    memoryBytes: 64 * MiB
  },
  {
    id: 'micro',
    label: 'Micro',
    description: 'Small services, bots',
    cpuMilli: 100,
    memoryBytes: 128 * MiB
  },
  {
    id: 'small',
    label: 'Small',
    description: 'Typical web apps',
    cpuMilli: 250,
    memoryBytes: 512 * MiB
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Busier apps, small workers',
    cpuMilli: 500,
    memoryBytes: 1024 * MiB
  },
  {
    id: 'large',
    label: 'Large',
    description: 'Heavy apps, small DBs',
    cpuMilli: 1000,
    memoryBytes: 2048 * MiB
  },
  {
    id: 'xlarge',
    label: 'XLarge',
    description: 'Compute-heavy, big services',
    cpuMilli: 2000,
    memoryBytes: 4096 * MiB
  }
];

export const DEFAULT_CPU_MILLI = 100;
export const DEFAULT_MEMORY_BYTES = 128 * MiB;

const DATABASE_IMAGE_REPOS = new Set([
  'postgres',
  'postgis/postgis',
  'pgvector/pgvector',
  'timescale/timescaledb',
  'supabase/postgres',
  'mysql',
  'mariadb',
  'mongo',
  'redis',
  'valkey/valkey',
  'clickhouse/clickhouse-server',
  'elasticsearch',
  'opensearchproject/opensearch'
]);

const DATABASE_DEFAULT_CPU_MILLI = 500;
const DATABASE_DEFAULT_MEMORY_BYTES = 1024 * MiB;

// A database gets a hard floor, not just a better default. The org-wide
// `defaultPodMemoryBytes` outranks the image-aware fallback below, so an org
// that set 128Mi for its app pods was silently handing that to Postgres too —
// which is not enough to run Postgres *and* its own base backup, whatever
// shared_buffers says. See db-tuning.ts for the incident this came from.
const DATABASE_MIN_MEMORY_BYTES = 256 * MiB;

export function isDatabaseImage(image?: string | null): boolean {
  return Boolean(image && DATABASE_IMAGE_REPOS.has(imageRepo(image)));
}

export function defaultPodResourcesForImage(image?: string | null): {
  cpuMilli: number;
  memoryBytes: number;
} {
  if (isDatabaseImage(image)) {
    return { cpuMilli: DATABASE_DEFAULT_CPU_MILLI, memoryBytes: DATABASE_DEFAULT_MEMORY_BYTES };
  }
  return { cpuMilli: DEFAULT_CPU_MILLI, memoryBytes: DEFAULT_MEMORY_BYTES };
}

export function minPodMemoryBytesForImage(image?: string | null): number {
  return isDatabaseImage(image) ? DATABASE_MIN_MEMORY_BYTES : 0;
}
