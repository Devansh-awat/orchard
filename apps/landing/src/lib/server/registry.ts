import { env } from '$env/dynamic/private';

export type CatalogEntry = {
	name: string;
	displayName: string;
	description?: string;
	icon?: string;
	category?: string;
	tags: string[];
	keywords?: string[];
	author?: string;
	homepage?: string;
	version: string;
	publishedAt: string;
	yaml: string;
	sha256: string;
	size: number;
	readme?: string;
	preview?: string;
	iconUrl?: string;
	index: string;
	source?: string;
	license?: string;
	addedBy?: Person;
	addedAt?: string;
	resources: ResourceSummary[];
};

export type Person = { name: string; login?: string };

export type ResourceSummary = { name: string; type: string; detail?: string };

export type Catalog = { generatedAt: string; templates: CatalogEntry[] };

export type FileInfo = { path: string; sha256: string; size: number; contentType: string };

export type VersionInfo = { version: string; publishedAt: string; files: Record<string, FileInfo> };

export type TemplateIndex = {
	name: string;
	displayName: string;
	description?: string;
	icon?: string;
	category?: string;
	tags: string[];
	author?: string;
	homepage?: string;
	latest: string;
	source?: string;
	license?: string;
	addedBy?: Person;
	addedAt?: string;
	versions: VersionInfo[];
};

export type Parameter = {
	name: string;
	displayName?: string;
	description?: string;
	type?: string;
	default?: unknown;
	required?: boolean;
	options?: { label: string; value: string }[];
};

export type TemplateJson = {
	name: string;
	displayName: string;
	description?: string;
	version: string;
	category?: string;
	tags: string[];
	author?: string;
	homepage?: string;
	license?: string;
	parameters: Parameter[];
	resources: ResourceSummary[];
};

export type TemplatePage = {
	index: TemplateIndex;
	latest: VersionInfo;
	template: TemplateJson;
	yaml: string;
	readme: string | null;
};

const FRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const TIMEOUT_MS = 6000;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

type Fetch = typeof globalThis.fetch;

const cache = new Map<string, { until: number; value: unknown }>();
const CACHE_MAX = 512;

export function registryBase() {
	return (env.REGISTRY_URL || 'https://assets.orchard.my/registry').replace(/\/+$/, '');
}

export function registryHref(path: string) {
	return `${registryBase()}/${path.replace(/^\/+/, '')}`;
}

async function fetchRegistry(fetch: Fetch, path: string) {
	const response = await fetch(registryHref(path), {
		headers: { 'user-agent': 'orchard-landing' },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`registry answered ${response.status} for ${path}`);
	return response;
}

async function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
	const hit = cache.get(key);
	if (hit && hit.until > Date.now()) return hit.value as T;
	try {
		const value = await load();
		if (value === null) {
			cache.delete(key);
			return value;
		}
		if (cache.size >= CACHE_MAX) {
			const now = Date.now();
			for (const [k, entry] of cache) if (entry.until <= now) cache.delete(k);
			if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
		}
		cache.set(key, { until: Date.now() + FRESH_MS, value });
		return value;
	} catch (error) {
		if (hit) {
			cache.set(key, { until: Date.now() + RETRY_MS, value: hit.value });
			return hit.value as T;
		}
		throw error;
	}
}

export async function catalog(
	fetch: Fetch
): Promise<{ templates: CatalogEntry[]; error: boolean }> {
	try {
		const templates = await remember('catalog', async () => {
			const response = await fetchRegistry(fetch, 'templates/index.json');
			if (!response) return [];
			const body = (await response.json()) as Catalog;
			return Array.isArray(body.templates) ? body.templates : [];
		});
		return { templates, error: false };
	} catch {
		return { templates: [], error: true };
	}
}

export async function templatePage(fetch: Fetch, name: string): Promise<TemplatePage | null> {
	if (!NAME.test(name)) return null;
	return remember(`template:${name}`, async () => {
		const indexResponse = await fetchRegistry(fetch, `templates/${name}/index.json`);
		if (!indexResponse) return null;
		const index = (await indexResponse.json()) as TemplateIndex;
		const latest = index.versions.find((v) => v.version === index.latest) ?? index.versions[0];
		if (!latest) return null;
		const [template, yaml, readme] = await Promise.all([
			fetchRegistry(fetch, latest.files['template.json']?.path ?? '').then((r) =>
				r ? (r.json() as Promise<TemplateJson>) : null
			),
			fetchRegistry(fetch, latest.files['template.yaml']?.path ?? '').then((r) =>
				r ? r.text() : null
			),
			latest.files['README.md']
				? fetchRegistry(fetch, latest.files['README.md'].path).then((r) => (r ? r.text() : null))
				: Promise.resolve(null)
		]);
		if (!template || yaml === null) return null;
		return { index, latest, template, yaml, readme };
	});
}

export type GraftVersion = {
	version: string;
	digest: string;
	url: string;
	size: number;
	signed: boolean;
	engines: Record<string, string>;
	capabilities: string[];
	manifest: string;
	readme?: string;
	publishedAt: string;
};

export type GraftEntry = {
	id: string;
	name: string;
	description: string;
	publisher: string;
	homepage?: string;
	icon?: string;
	latest: string;
	versions: GraftVersion[];
};

type GraftCatalog = { generatedAt: string; grafts: GraftEntry[]; revoked: string[] };

export async function graftCatalog(
	fetch: Fetch
): Promise<{ grafts: GraftEntry[]; error: boolean }> {
	try {
		const grafts = await remember('grafts', async () => {
			const response = await fetchRegistry(fetch, 'grafts/index.json');
			if (!response) return [];
			const body = (await response.json()) as GraftCatalog;
			const revoked = new Set(body.revoked ?? []);
			return (Array.isArray(body.grafts) ? body.grafts : []).map((g) => ({
				...g,
				versions: g.versions.filter((v) => !revoked.has(v.digest))
			}));
		});
		return { grafts: grafts.filter((g) => g.versions.length), error: false };
	} catch {
		return { grafts: [], error: true };
	}
}
