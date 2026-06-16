export function formatCpuMilli(milli: number): string {
	if (!milli) return '0m';
	if (milli >= 1000) return `${(milli / 1000).toFixed(2).replace(/\.?0+$/, '')} cores`;
	if (milli >= 10) return `${Math.round(milli)}m`;
	if (milli >= 1) return `${milli.toFixed(1).replace(/\.0$/, '')}m`;
	return `<1m`;
}

export function formatMemoryBytes(bytes: number): string {
	if (!bytes) return '0 B';
	const units: Array<[string, number]> = [
		['Ti', 1024 ** 4],
		['Gi', 1024 ** 3],
		['Mi', 1024 ** 2],
		['Ki', 1024]
	];
	for (const [u, m] of units) {
		if (bytes >= m) return `${(bytes / m).toFixed(2).replace(/\.?0+$/, '')} ${u}`;
	}
	return `${bytes} B`;
}
