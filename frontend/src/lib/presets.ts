// Mirrors server/src/kubernetes/presets.ts.
export type ResourcePreset = {
	id: string;
	label: string;
	description: string;
	cpuMilli: number;
	memoryBytes: number;
};

const MiB = 1024 * 1024;

export const RESOURCE_PRESETS: ResourcePreset[] = [
	{ id: 'nano',   label: 'Nano',   description: 'Cron jobs, hello-worlds',    cpuMilli: 50,   memoryBytes: 64 * MiB },
	{ id: 'micro',  label: 'Micro',  description: 'Small services, bots',       cpuMilli: 100,  memoryBytes: 128 * MiB },
	{ id: 'small',  label: 'Small',  description: 'Typical web apps',           cpuMilli: 250,  memoryBytes: 512 * MiB },
	{ id: 'medium', label: 'Medium', description: 'Busier apps, small workers', cpuMilli: 500,  memoryBytes: 1024 * MiB },
	{ id: 'large',  label: 'Large',  description: 'Heavy apps, small DBs',      cpuMilli: 1000, memoryBytes: 2048 * MiB },
	{ id: 'xlarge', label: 'XLarge', description: 'Compute-heavy, big services', cpuMilli: 2000, memoryBytes: 4096 * MiB },
];

export const DEFAULT_CPU_MILLI = 100;
export const DEFAULT_MEMORY_BYTES = 128 * MiB;

export function matchPreset(cpuMilli: number, memoryBytes: number): string | null {
	const p = RESOURCE_PRESETS.find((p) => p.cpuMilli === cpuMilli && p.memoryBytes === memoryBytes);
	return p?.id ?? null;
}

export function formatCpu(milli: number): string {
	if (milli >= 1000 && milli % 1000 === 0) return `${milli / 1000} core${milli === 1000 ? '' : 's'}`;
	if (milli >= 1000) return `${(milli / 1000).toFixed(2)} cores`;
	return `${milli}m`;
}

export function formatMemory(bytes: number): string {
	const Gi = 1024 ** 3;
	const Mi = 1024 ** 2;
	if (bytes >= Gi && bytes % Gi === 0) return `${bytes / Gi} GB`;
	if (bytes >= Gi) return `${(bytes / Gi).toFixed(2)} GB`;
	return `${Math.round(bytes / Mi)} MB`;
}
