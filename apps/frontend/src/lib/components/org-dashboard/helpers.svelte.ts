import { identicon } from '$lib/utils/identicon';
import { elapsedSince } from '$lib/utils/clock.svelte';

const TECH = '/icons/tech';

export const IMG_ICONS: Record<string, string> = {
	postgres: `${TECH}/postgresql-original.svg`,
	postgresql: `${TECH}/postgresql-original.svg`,
	mysql: `${TECH}/mysql-original.svg`,
	redis: `${TECH}/redis-original.svg`,
	mongo: `${TECH}/mongodb-original.svg`,
	mongodb: `${TECH}/mongodb-original.svg`,
	nginx: `${TECH}/nginx-original.svg`,
	node: `${TECH}/nodejs-original.svg`,
	python: `${TECH}/python-original.svg`,
	go: `${TECH}/go-original.svg`,
	rust: `${TECH}/rust-original.svg`,
	grafana: `${TECH}/grafana-original.svg`
};

export function knownIcon(img?: string): string | null {
	if (!img) return null;
	const n =
		img
			.replace(/^[^/]+\.[^/]+\//, '')
			.split(':')[0]
			.split('/')
			.pop()
			?.toLowerCase() ?? '';
	if (IMG_ICONS[n]) return IMG_ICONS[n];
	for (const [k, v] of Object.entries(IMG_ICONS)) {
		if (n.startsWith(k) || n.includes(k)) return v;
	}
	return null;
}

export function timeAgo(d?: string): string {
	if (!d) return '';
	const s = Math.floor(elapsedSince(new Date(d).getTime()) / 1000);
	if (s < 60) return 'just now';
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const dy = Math.floor(h / 24);
	if (dy < 30) return `${dy}d ago`;
	return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function favUrl(host: string) {
	return `/apiv1/deployments/favicon?domain=${encodeURIComponent(host)}`;
}

const ORCHARD_HUES = [352, 335, 24, 38, 88, 130, 288, 220];

/**
 * A deterministic tinted plate behind a favicon, so a logo with transparency
 * fills the tile with colour instead of sitting on a flat/empty square. The hue
 * comes from the same curated Orchard palette the pixel swatches use, and the
 * gradient stays analogous (hue → hue+22) so it reads as one cohesive tile
 * rather than a random neon. Stable per seed, so an app's colour never changes.
 */
export function iconTint(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	const hue = ORCHARD_HUES[hash % ORCHARD_HUES.length];
	return `linear-gradient(140deg, hsl(${hue} 60% 53%), hsl(${(hue + 22) % 360} 56% 42%))`;
}

export function projectSwatch(slug: string): string {
	return `background-image: url("${identicon(slug)}"); background-size: 100% 100%`;
}

export function buildIcon(
	img: string | undefined,
	ings: { host: string }[] | undefined,
	id: string | undefined,
	failedFav: Set<string>,
	faviconUrl?: string | null
) {
	const k = knownIcon(img);
	if (k) return k;
	if (failedFav.has(`b-${id ?? ''}`)) return null;
	// Prefer the R2 URL the overview already resolved: no backend round trip
	if (faviconUrl) return faviconUrl;
	if (ings?.length) return favUrl(ings[0].host.split('/')[0]);
	return null;
}
