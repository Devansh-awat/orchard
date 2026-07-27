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

export interface DetectedApp {
	dir: string;
	framework: string;
	installCommand: string | null;
	buildCommand: string | null;
	startCommand: string | null;
	outputDirectory: string | null;
	port: number;
	packageName: string | null;
}

export const FRAMEWORK_LABELS: Record<string, string> = {
	nextjs: 'Next.js',
	next: 'Next.js',
	sveltekit: 'SvelteKit',
	nuxt: 'Nuxt',
	astro: 'Astro',
	remix: 'Remix',
	'react-router': 'React Router',
	'tanstack-start': 'TanStack Start',
	cra: 'Create React App',
	angular: 'Angular',
	nestjs: 'NestJS',
	fastify: 'Fastify',
	express: 'Express',
	vite: 'Vite',
	node: 'Node.js',
	deno: 'Deno',
	go: 'Go',
	python: 'Python',
	ruby: 'Ruby',
	rust: 'Rust',
	php: 'PHP',
	java: 'Java',
	elixir: 'Elixir',
	static: 'Static site',
	staticfile: 'Static site'
};

export function frameworkLabel(framework: string | null | undefined): string | null {
	if (!framework) return null;
	return FRAMEWORK_LABELS[framework] ?? framework;
}

export function appDirLabel(dir: string): string {
	return dir === '' ? 'Repository root' : dir;
}

/**
 * Defaults applied when someone picks a framework by hand, mirroring what
 * detection would have produced. Output directory drives static serving, so a
 * null here means "runs a server".
 */
export const FRAMEWORK_PRESETS: Record<string, { outputDirectory: string | null; port: number }> = {
	vite: { outputDirectory: 'dist', port: 80 },
	cra: { outputDirectory: 'build', port: 80 },
	'react-router': { outputDirectory: 'build/client', port: 80 },
	astro: { outputDirectory: 'dist', port: 4321 },
	angular: { outputDirectory: null, port: 80 },
	static: { outputDirectory: '.', port: 80 },
	nextjs: { outputDirectory: null, port: 3000 },
	sveltekit: { outputDirectory: null, port: 3000 },
	nuxt: { outputDirectory: null, port: 3000 },
	remix: { outputDirectory: null, port: 3000 },
	nestjs: { outputDirectory: null, port: 3000 },
	fastify: { outputDirectory: null, port: 3000 },
	express: { outputDirectory: null, port: 3000 },
	node: { outputDirectory: null, port: 3000 },
	go: { outputDirectory: null, port: 8080 },
	python: { outputDirectory: null, port: 8000 },
	ruby: { outputDirectory: null, port: 3000 },
	rust: { outputDirectory: null, port: 8080 },
	php: { outputDirectory: null, port: 8080 }
};

/** Frameworks offered in the picker, in the order they should appear. */
export const FRAMEWORK_CHOICES = [
	'nextjs',
	'sveltekit',
	'nuxt',
	'astro',
	'remix',
	'react-router',
	'vite',
	'cra',
	'angular',
	'static',
	'nestjs',
	'express',
	'fastify',
	'node',
	'go',
	'python',
	'ruby',
	'rust',
	'php'
];
