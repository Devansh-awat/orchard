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
	const total = Math.floor(seconds);
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

export {
	envVarsToSealedRaw as envVarsToRaw,
	parseEnvLines as rawToEnvVars,
	rawToEnvVarsKeepingSecrets
} from '$lib/utils/env-secrets';

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

const MUTABLE_TAGS = new Set([
	'latest',
	'main',
	'master',
	'stable',
	'edge',
	'dev',
	'develop',
	'nightly',
	'prod',
	'production',
	'release'
]);

export function imageTag(image: string): string | null {
	const noDigest = String(image ?? '')
		.trim()
		.split('@')[0];
	if (!noDigest) return null;
	let remainder = noDigest;
	const slashIdx = noDigest.indexOf('/');
	if (slashIdx > 0) {
		const maybeHost = noDigest.slice(0, slashIdx);
		if (maybeHost.includes('.') || maybeHost.includes(':') || maybeHost === 'localhost') {
			remainder = noDigest.slice(slashIdx + 1);
		}
	}
	const colonIdx = remainder.lastIndexOf(':');
	if (colonIdx === -1) return null;
	return remainder.slice(colonIdx + 1) || null;
}

export function isMutableTag(image: string | null | undefined): boolean {
	const raw = String(image ?? '').trim();
	if (!raw) return false;
	if (raw.includes('@sha256:')) return false;
	const tag = imageTag(raw);
	if (tag === null) return true;
	if (MUTABLE_TAGS.has(tag.toLowerCase())) return true;
	return /^v?\d+(\.\d+)?$/.test(tag);
}

export interface ReplicaDrift {
	/** What Kubernetes is actually asked to run. */
	observed: number;
	/** What Orchard intends, and what a restart would come back to. */
	desired: number;
	stopped: boolean;
}

/**
 * Whether the replica count on screen is the whole story.
 *
 * `replicas` is intent and the mirrored `specReplicas` is what the cluster is
 * running, and the two are allowed to disagree: a stopped deployment keeps its
 * count so it can return to it, and an external scale is only adopted into the
 * row when nothing is mid-build or mid-apply. Rendering intent alone is how a
 * deployment sitting at zero pods reported one replica for eleven days.
 *
 * Returns null when there is nothing to explain — either they agree, or the
 * mirror has not seen the object yet and we have no observation to offer.
 */
export function replicaDrift(deployment: {
	replicas?: number | null;
	stopped?: boolean | null;
	specReplicas?: number | null;
}): ReplicaDrift | null {
	const desired = deployment.replicas ?? 0;
	const observed = deployment.specReplicas;
	if (observed == null) return null;
	const stopped = Boolean(deployment.stopped);
	if (!stopped && observed === desired) return null;
	return { observed, desired, stopped };
}
