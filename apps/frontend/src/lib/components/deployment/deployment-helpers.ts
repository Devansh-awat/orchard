export function podLabel(podName: string): string {
	const parts = podName.split('-');
	return parts.length >= 2 ? parts[parts.length - 1] : podName;
}

export function getNewestPod<T extends { status?: string; startTime?: string }>(
	pods: T[]
): T | null {
	const active = pods.filter((p) => p.status?.toLowerCase() !== 'succeeded');
	if (!active.length) return null;
	return active.reduce((newest, pod) => {
		if (!newest.startTime) return pod;
		if (!pod.startTime) return newest;
		return new Date(pod.startTime) > new Date(newest.startTime) ? pod : newest;
	});
}

export function formatBuildElapsed(seconds: number): string {
	const total = Math.round(seconds);
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

export function sanitizeLogs(logs: string): string {
	if (!logs) return logs;
	let sanitized = logs;
	sanitized = sanitized.replace(
		/(x-access-token:|ghs_|ghp_|github_pat_)[a-zA-Z0-9_]+/gi,
		'***REDACTED***'
	);
	sanitized = sanitized.replace(
		/https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi,
		'https://***@github.com'
	);
	sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');
	sanitized = sanitized.replace(
		/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-.]+/gi,
		'$1 ***REDACTED***'
	);
	sanitized = sanitized.replace(
		/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi,
		'$1=***REDACTED***'
	);
	return sanitized;
}

export function envVarsToRaw(vars: { key: string; value: string }[]): string {
	return vars
		.filter((e) => e.key.trim())
		.map((e) => `${e.key}=${e.value}`)
		.join('\n');
}

export function rawToEnvVars(raw: string): { key: string; value: string }[] {
	const lines = raw.split('\n');
	const parsed: { key: string; value: string }[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const equalIndex = trimmed.indexOf('=');
		if (equalIndex === -1) continue;
		const key = trimmed.substring(0, equalIndex).trim();
		const value = trimmed.substring(equalIndex + 1).trim();
		if (key) parsed.push({ key, value });
	}
	return parsed;
}
