// Shared resource presets. Keep in sync with frontend/src/lib/presets.ts.
export interface ResourcePreset {
  id: string;
  label: string;
  description: string;
  cpuMilli: number;
  memoryBytes: number;
}

const MiB = 1024 * 1024;

export const RESOURCE_PRESETS: ResourcePreset[] = [
  { id: 'nano',   label: 'Nano',   description: 'Cron jobs, hello-worlds',       cpuMilli: 50,   memoryBytes: 64 * MiB },
  { id: 'micro',  label: 'Micro',  description: 'Small services, bots',          cpuMilli: 100,  memoryBytes: 128 * MiB },
  { id: 'small',  label: 'Small',  description: 'Typical web apps',              cpuMilli: 250,  memoryBytes: 512 * MiB },
  { id: 'medium', label: 'Medium', description: 'Busier apps, small workers',    cpuMilli: 500,  memoryBytes: 1024 * MiB },
  { id: 'large',  label: 'Large',  description: 'Heavy apps, small DBs',         cpuMilli: 1000, memoryBytes: 2048 * MiB },
  { id: 'xlarge', label: 'XLarge', description: 'Compute-heavy, big services',   cpuMilli: 2000, memoryBytes: 4096 * MiB },
];

export const DEFAULT_CPU_MILLI = 100;
export const DEFAULT_MEMORY_BYTES = 128 * MiB;
