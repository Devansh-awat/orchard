import { animate } from 'motion';
import { functionalMotion } from '$lib/utils/motion.svelte';
import { resourceStatus } from '$lib/components/ui';
import type { StatusKind } from '$lib/components/ui';
import type { ProjectGroup } from './types';

export const IMG_ICONS: Record<string, string> = {
	postgres:
		'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/postgresql/postgresql-original.svg',
	postgresql:
		'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/postgresql/postgresql-original.svg',
	mysql: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/mysql/mysql-original.svg',
	redis: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/redis/redis-original.svg',
	mongo: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/mongodb/mongodb-original.svg',
	mongodb: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/mongodb/mongodb-original.svg',
	nginx: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/nginx/nginx-original.svg',
	node: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/nodejs/nodejs-original.svg',
	python: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/python/python-original.svg',
	go: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/go/go-original.svg',
	rust: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/rust/rust-original.svg',
	grafana: 'https://cdn.jsdelivr.net/gh/devicons/devicon@2.17.0/icons/grafana/grafana-original.svg'
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
	const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
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

const swatchCache = new Map<string, string>();

export function projectSwatch(slug: string): string {
	const cached = swatchCache.get(slug);
	if (cached) return cached;
	let hash = 0;
	for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
	const hue = hash % 360;
	let bits = hash || 1;
	const next = () => {
		bits = (bits * 1103515245 + 12345) >>> 0;
		return bits;
	};
	const cells: boolean[] = [];
	for (let i = 0; i < 15; i++) cells.push(next() % 100 < 52);
	if (!cells.some(Boolean)) cells[7] = true;
	let rects = '';
	for (let i = 0; i < 15; i++) {
		if (!cells[i]) continue;
		const col = Math.floor(i / 5);
		const row = i % 5;
		rects += `<rect x='${col}' y='${row}' width='1' height='1'/>`;
		if (col < 2) rects += `<rect x='${4 - col}' y='${row}' width='1' height='1'/>`;
	}
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 5 5' shape-rendering='crispEdges'><rect width='5' height='5' fill='hsl(${hue} 45% 92%)'/><g fill='hsl(${hue} 60% 48%)'>${rects}</g></svg>`;
	const style = `background-image: url("data:image/svg+xml,${encodeURIComponent(svg)}"); background-size: 100% 100%`;
	swatchCache.set(slug, style);
	return style;
}

export function projectStatusSummary(g: ProjectGroup) {
	let green = 0;
	let amber = 0;
	let red = 0;
	const bump = (kind: StatusKind) => {
		if (kind === 'success') green++;
		else if (kind === 'progress' || kind === 'warning') amber++;
		else if (kind === 'error') red++;
	};
	for (const d of g.deps) bump(resourceStatus(d.status, d.buildStatus).kind);
	for (const db of g.dbs) bump(resourceStatus(db.status).kind);
	if (!green && !amber && !red) return null;
	return { green, amber, red };
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
	// Prefer the R2 URL the overview already resolved — no backend round trip
	if (faviconUrl) return faviconUrl;
	if (ings?.length) return favUrl(ings[0].host.split('/')[0]);
	return null;
}

function proxied(raw: string): string {
	try {
		const u = new URL(raw, window.location.href);
		if (u.origin === window.location.origin) return u.href;
		return `/asset-proxy?u=${encodeURIComponent(u.href)}`;
	} catch {
		return raw;
	}
}

const blurCache = new Map<string, Promise<string | null>>();
function blurBake(url: string): Promise<string | null> {
	let p = blurCache.get(url);
	if (p) return p;
	p = new Promise((resolve) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => {
			try {
				const W = 640;
				const H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W));
				const canvas = document.createElement('canvas');
				canvas.width = W;
				canvas.height = H;
				const ctx = canvas.getContext('2d');
				if (!ctx) return resolve(null);
				ctx.filter = 'blur(80px) saturate(1.6)';
				ctx.drawImage(img, 0, 0, W, H);
				resolve(canvas.toDataURL('image/jpeg', 0.85));
			} catch {
				resolve(null);
			}
		};
		img.onerror = () => resolve(null);
		img.src = proxied(url);
	});
	blurCache.set(url, p);
	return p;
}

export function meshBakedBg(url: string) {
	return (el: Element) => {
		const target = el as HTMLElement;
		let cancelled = false;

		blurBake(url).then((dataUrl) => {
			if (cancelled || !dataUrl) return;
			target.style.setProperty('--mesh-bg', `url("${dataUrl}")`);
			target.classList.add('proj-card-backdrop--ready');
		});

		return () => {
			cancelled = true;
		};
	};
}

export function bodyAttach(
	id: string,
	isExpanded: () => boolean,
	projectBodyEls: Map<string, HTMLElement>,
	getRenderedProjectBodies: () => Set<string>,
	setRenderedProjectBodies: (s: Set<string>) => void
) {
	return (el: Element) => {
		const target = el as HTMLElement;
		projectBodyEls.set(id, target);
		target.style.overflow = 'hidden';
		target.style.willChange = 'height';
		let firstEffect = true;
		let gen = 0;
		const measure = () => {
			const cur = target.style.height;
			target.style.height = 'auto';
			const h = target.scrollHeight;
			target.style.height = cur;
			return h;
		};
		const sympathy = (compress: boolean) => {
			const grid = target.querySelector<HTMLElement>('.od-grid');
			if (grid) {
				const yKick = compress ? 8 : -6;
				animate(
					grid,
					{ y: [yKick, 0], scaleY: [compress ? 0.94 : 0.96, 1] },
					{ type: 'spring', stiffness: 200, damping: 13, mass: 1, delay: 0.04 }
				);
			}
		};
		$effect(() => {
			const open = isExpanded();
			const myGen = ++gen;
			if (!functionalMotion()) {
				firstEffect = false;
				target.style.height = open ? 'auto' : '0px';
				target.style.opacity = open ? '1' : '0';
				if (!open) {
					setRenderedProjectBodies(
						new Set([...getRenderedProjectBodies()].filter((x) => x !== id))
					);
					projectBodyEls.delete(id);
				}
				return;
			}
			if (firstEffect) {
				firstEffect = false;
				target.style.opacity = '0';
				target.style.height = '0px';
				void target.offsetHeight;
				const h = target.scrollHeight;
				animate(
					target,
					{ height: h, opacity: 1 },
					{ type: 'spring', stiffness: 220, damping: 16, mass: 0.9 }
				).finished.then(() => {
					if (myGen !== gen) return;
					target.style.height = 'auto';
					target.style.opacity = '1';
				});
				sympathy(false);
				return;
			}
			if (open) {
				const cur = target.getBoundingClientRect().height;
				target.style.height = `${cur}px`;
				void target.offsetHeight;
				const h = measure();
				animate(
					target,
					{ height: h, opacity: 1 },
					{ type: 'spring', stiffness: 220, damping: 16, mass: 0.9 }
				).finished.then(() => {
					if (myGen !== gen) return;
					target.style.height = 'auto';
					target.style.opacity = '1';
				});
				sympathy(false);
			} else {
				const cur = target.getBoundingClientRect().height;
				target.style.height = `${cur}px`;
				void target.offsetHeight;
				const card = target.closest('.proj-card') as HTMLElement | null;
				if (card) card.style.transformOrigin = 'top center';
				const grid = target.querySelector<HTMLElement>('.od-grid');
				if (grid) {
					animate(
						grid,
						{ y: 6, scaleY: 0.96, opacity: 0.8 },
						{ duration: 0.22, ease: [0.4, 0, 1, 1] }
					);
				}
				animate(
					target,
					{ height: 0, opacity: 0 },
					{ duration: 0.24, ease: [0.4, 0, 1, 1] }
				).finished.then(() => {
					if (myGen !== gen) return;
					if (card) {
						animate(card, { y: [-5, 0] }, { type: 'spring', stiffness: 120, damping: 10, mass: 1 });
					}
					if (!isExpanded()) {
						setRenderedProjectBodies(
							new Set([...getRenderedProjectBodies()].filter((x) => x !== id))
						);
						projectBodyEls.delete(id);
					}
				});
			}
		});
		return () => {
			projectBodyEls.delete(id);
		};
	};
}
