import { animate } from 'motion';
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

export function dotClass(s?: string, bs?: string) {
	if (bs === 'building') return 'dot--amber';
	if (!s) return 'dot--gray';
	const l = s.toLowerCase();
	if (l === 'running') return 'dot--green';
	if (['pending', 'restarting', 'scaling'].includes(l)) return 'dot--amber';
	if (['failed', 'error', 'deleting', 'stopped', 'unhealthy'].includes(l)) return 'dot--red';
	return 'dot--gray';
}

export function statusText(s?: string, bs?: string): string {
	if (bs === 'building') return 'Building';
	if (!s) return 'Unknown';
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
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

export function projectStatusSummary(g: ProjectGroup) {
	let green = 0,
		amber = 0,
		red = 0;
	const bump = (cls: string) => {
		if (cls === 'dot--green') green++;
		else if (cls === 'dot--amber') amber++;
		else if (cls === 'dot--red') red++;
	};
	for (const d of g.deps) bump(dotClass(d.status, d.buildStatus));
	for (const db of g.dbs) {
		bump(db.status === 'ready' ? 'dot--green' : db.status === 'error' ? 'dot--red' : 'dot--amber');
	}
	if (!green && !amber && !red) return null;
	return { green, amber, red };
}

export function buildIcon(
	img: string | undefined,
	ings: Array<{ host: string }> | undefined,
	id: string | undefined,
	failedFav: Set<string>,
	faviconUrl?: string | null
) {
	const k = knownIcon(img);
	if (k) return k;
	if (failedFav.has('b-' + (id ?? ''))) return null;
	// Prefer the R2 URL the overview already resolved — no backend round trip
	if (faviconUrl) return faviconUrl;
	if (ings?.length) return favUrl(ings[0].host.split('/')[0]);
	return null;
}

function proxied(raw: string): string {
	try {
		const u = new URL(raw, location.href);
		if (u.origin === location.origin) return u.href;
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

		const io = new IntersectionObserver((entries) => {
			const on = entries.some((e) => e.isIntersecting);
			target.classList.toggle('proj-card-backdrop--offscreen', !on);
		});
		io.observe(target);

		return () => {
			cancelled = true;
			io.disconnect();
		};
	};
}

export function springPop(active: () => boolean) {
	return (el: Element) => {
		const target = el as HTMLElement;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next && !prev) {
				animate(
					target,
					{ scale: [0.9, 1.06, 1] },
					{ type: 'spring', stiffness: 480, damping: 16, mass: 0.85 }
				);
			}
			prev = next;
		});
	};
}

export function springRotate(
	active: () => boolean,
	opts: { rest?: number; on?: number; stiffness?: number; damping?: number; mass?: number } = {}
) {
	const rest = opts.rest ?? 0;
	const on = opts.on ?? 90;
	const stiffness = opts.stiffness ?? 380;
	const damping = opts.damping ?? 24;
	const mass = opts.mass ?? 0.7;
	return (el: Element) => {
		const target = el as HTMLElement;
		target.style.transform = `rotate(${active() ? on : rest}deg)`;
		let prev = active();
		$effect(() => {
			const next = active();
			if (next === prev) return;
			prev = next;
			animate(target, { rotate: next ? on : rest }, { type: 'spring', stiffness, damping, mass });
		});
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
