const FRAMEWORKS: Record<string, string> = {
	nextjs: 'Next.js',
	sveltekit: 'SvelteKit',
	nuxt: 'Nuxt',
	astro: 'Astro',
	remix: 'Remix',
	express: 'Express',
	fastify: 'Fastify',
	django: 'Django',
	flask: 'Flask',
	fastapi: 'FastAPI',
	rails: 'Rails',
	gin: 'Gin',
	echo: 'Echo',
	fiber: 'Fiber',
	spring: 'Spring',
	laravel: 'Laravel',
	phoenix: 'Phoenix'
};

const LANGUAGES: Record<string, string> = {
	node: 'Node.js',
	python: 'Python',
	go: 'Go',
	ruby: 'Ruby',
	java: 'Java',
	dotnet: '.NET',
	rust: 'Rust',
	php: 'PHP',
	elixir: 'Elixir'
};

export type DetectedRuntime = {
	language: string;
	framework: string | null;
	version: string | null;
};

export function runtimeName(rt: DetectedRuntime | null | undefined): string | null {
	if (!rt || rt.language === 'unknown') return null;
	const name = rt.framework
		? (FRAMEWORKS[rt.framework] ?? rt.framework)
		: (LANGUAGES[rt.language] ?? rt.language);
	return rt.version ? `${name} ${rt.version}` : name;
}

export function uptime(since: string | null | undefined): string | null {
	if (!since) return null;
	const s = (Date.now() - new Date(since).getTime()) / 1000;
	if (!Number.isFinite(s) || s < 0) return null;
	if (s < 60) return `${Math.floor(s)}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}
