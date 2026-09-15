const UNIT_BYTES = {
	Mi: 1024n ** 2n,
	Gi: 1024n ** 3n,
	Ti: 1024n ** 4n
} as const;

const MAX_STORAGE_BYTES = 200n * UNIT_BYTES.Gi;

export function parseStorageBytes(value: string | null | undefined): bigint | null {
	const match = value?.trim().match(/^([1-9]\d*)(Mi|Gi|Ti)$/);
	if (!match) return null;
	return BigInt(match[1]) * UNIT_BYTES[match[2] as keyof typeof UNIT_BYTES];
}

export function storageExpansionError(
	current: string | null | undefined,
	requested: string
): string | null {
	const requestedBytes = parseStorageBytes(requested);
	if (requestedBytes == null) return 'Enter a whole number followed by Mi, Gi, or Ti.';
	if (requestedBytes > MAX_STORAGE_BYTES) return 'Storage cannot exceed 200Gi.';
	const currentBytes = parseStorageBytes(current);
	if (currentBytes == null) return 'The current storage size is unavailable.';
	if (requestedBytes <= currentBytes) return `Enter a size larger than ${current}.`;
	return null;
}

export function totalAllocatedStorage(requested: string, instances: number): string | null {
	const bytes = parseStorageBytes(requested);
	if (bytes == null) return null;
	const total = bytes * BigInt(Math.max(1, Math.trunc(instances)));
	if (total % UNIT_BYTES.Ti === 0n) return `${total / UNIT_BYTES.Ti}Ti`;
	if (total % UNIT_BYTES.Gi === 0n) return `${total / UNIT_BYTES.Gi}Gi`;
	return `${total / UNIT_BYTES.Mi}Mi`;
}
