import { identicon } from '$lib/utils/identicon';
import { animate } from 'motion';
import { motionEnabled, motion, transition, springToFloor } from '$lib/utils/motion.svelte';
import { elapsedSince } from '$lib/utils/clock.svelte';
import { resourceStatus } from '$lib/components/ui';
import type { StatusKind } from '$lib/components/ui';
import type { ProjectGroup } from './types';

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

const bodyPad = new WeakMap<Element, number>();

export function bodyAttach(
	id: string,
	isExpanded: () => boolean,
	projectBodyEls: Map<string, HTMLElement>,
	getRenderedProjectBodies: () => Set<string>,
	setRenderedProjectBodies: (s: Set<string>) => void
) {
	return (el: Element) => {
		const target = el as HTMLElement;
		// Cached on first sight, while nothing is animating. This attachment is
		// re-created when a sibling attribute changes; if that lands mid-collapse,
		// a running WAAPI animation is driving padding and `getComputedStyle`
		// reports a fraction of a pixel. Capturing that as the resting value is
		// what left every later open 16px short and snapping at the end.
		if (!bodyPad.has(target)) {
			bodyPad.set(target, parseFloat(getComputedStyle(target).paddingTop) || 16);
		}
		const PAD = bodyPad.get(target)!;
		projectBodyEls.set(id, target);
		target.style.overflow = 'hidden';
		let firstEffect = true;
		let gen = 0;
		const measure = () => {
			const prevH = target.style.height;
			const prevPT = target.style.paddingTop;
			const prevPB = target.style.paddingBottom;
			target.style.height = 'auto';
			target.style.paddingTop = '';
			target.style.paddingBottom = '';
			const h = target.scrollHeight;
			target.style.height = prevH;
			target.style.paddingTop = prevPT;
			target.style.paddingBottom = prevPB;
			return h;
		};
		// The tiles carry the open/close themselves via originBurst, flying out of
		// and back into the project avatar. Moving or fading the grid on top of
		// that drags every tile with it and hides them before they get home.
		const resetGrid = () => {
			const grid = target.querySelector<HTMLElement>('.od-grid');
			if (!grid) return;
			grid.style.opacity = '';
			grid.style.transform = '';
		};

		// The height/padding animation has to be cancellable: reversing direction
		// mid-flight otherwise leaves the old run still driving padding back to 0,
		// which fights the new one and lands the content 16px out of place.
		let bodyAnim: ReturnType<typeof animate> | null = null;
		const stopBodyAnim = () => {
			bodyAnim?.stop();
			bodyAnim = null;
		};

		let reflowRo: ResizeObserver | null = null;
		let lastBodyH = 0;
		let lastSlots: { x: number; y: number }[] = [];

		const slotsOf = (grid: HTMLElement) =>
			[...grid.children].map((c) => ({
				x: (c as HTMLElement).offsetLeft,
				y: (c as HTMLElement).offsetTop
			}));

		const stopReflowWatch = () => {
			reflowRo?.disconnect();
			reflowRo = null;
		};

		const startReflowWatch = (myGen: number) => {
			stopReflowWatch();
			const grid = target.querySelector<HTMLElement>('.od-grid');
			if (!grid || typeof ResizeObserver === 'undefined') return;
			lastBodyH = target.getBoundingClientRect().height;
			lastSlots = slotsOf(grid);
			let first = true;
			reflowRo = new ResizeObserver(() => {
				if (first) {
					first = false;
					return;
				}
				if (myGen !== gen || target.style.height !== 'auto') return;

				const toH = target.getBoundingClientRect().height;
				const fromH = lastBodyH;
				const slots = slotsOf(grid);
				const moved =
					slots.length === lastSlots.length &&
					slots.some(
						(s, i) => Math.abs(s.x - lastSlots[i].x) > 1 || Math.abs(s.y - lastSlots[i].y) > 1
					);

				if (!moved && Math.abs(toH - fromH) < 4) {
					lastBodyH = toH;
					lastSlots = slots;
					return;
				}

				if (moved) {
					const kids = [...grid.children] as HTMLElement[];
					const deltas = kids.map((_, i) => ({
						dx: lastSlots[i].x - slots[i].x,
						dy: lastSlots[i].y - slots[i].y
					}));
					kids.forEach((kid, i) => {
						const { dx, dy } = deltas[i];
						if (!dx && !dy) return;
						kid.style.transform = `translate(${dx}px, ${dy}px)`;
					});
					void grid.offsetHeight;
					kids.forEach((kid, i) => {
						const { dx, dy } = deltas[i];
						if (!dx && !dy) return;
						motion(kid, { x: [dx, 0], y: [dy, 0] }, 'smooth');
					});
				}

				lastBodyH = toH;
				lastSlots = slots;

				if (Math.abs(toH - fromH) >= 4) {
					target.style.height = `${fromH}px`;
					void target.offsetHeight;
					animate(target, { height: toH }, transition('snappy')).finished.then(() => {
						if (myGen !== gen) return;
						target.style.height = 'auto';
						lastBodyH = target.getBoundingClientRect().height;
					});
				}
			});
			reflowRo.observe(grid);
		};
		$effect(() => {
			const open = isExpanded();
			const myGen = ++gen;
			// Cancel before touching styles: stopping a Motion animation commits its
			// current value inline, so cancelling later would clobber the padding we
			// are about to restore and leave the content a pixel off its slot.
			stopBodyAnim();
			if (!motionEnabled()) {
				firstEffect = false;
				stopReflowWatch();
				resetGrid();
				target.style.height = open ? 'auto' : '0px';
				target.style.opacity = open ? '1' : '0';
				target.style.paddingTop = open ? '' : '0px';
				target.style.paddingBottom = open ? '' : '0px';
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
				target.style.paddingTop = `${PAD}px`;
				target.style.paddingBottom = `${PAD}px`;
				if (!open) {
					setRenderedProjectBodies(
						new Set([...getRenderedProjectBodies()].filter((x) => x !== id))
					);
					projectBodyEls.delete(id);
					return;
				}
				target.style.paddingTop = `${PAD}px`;
				target.style.paddingBottom = `${PAD}px`;
				void target.offsetHeight;
				const h = measure();
				bodyAnim = animate(
					target,
					{ height: h, opacity: 1 },
					transition('snappy', { distance: h })
				);
				bodyAnim.finished.then(() => {
					if (myGen !== gen) return;
					target.style.height = 'auto';
					target.style.opacity = '1';
					target.style.paddingTop = '';
					target.style.paddingBottom = '';
					startReflowWatch(myGen);
				});
				resetGrid();
				return;
			}
			if (open) {
				stopReflowWatch();
				const cur = target.getBoundingClientRect().height;
				target.style.height = `${cur}px`;
				// Padding goes back up front, not in .finished. An interrupted close
				// leaves it at 0, and restoring it only once the height animation
				// ends drops the content 16px after everything has already settled.
				target.style.paddingTop = `${PAD}px`;
				target.style.paddingBottom = `${PAD}px`;
				void target.offsetHeight;
				const h = measure();
				bodyAnim = animate(
					target,
					{ height: h, opacity: 1 },
					transition('snappy', { distance: h })
				);
				bodyAnim.finished.then(() => {
					if (myGen !== gen) return;
					target.style.height = 'auto';
					target.style.opacity = '1';
					target.style.paddingTop = '';
					target.style.paddingBottom = '';
					startReflowWatch(myGen);
				});
				resetGrid();
			} else {
				stopReflowWatch();
				const cur = target.getBoundingClientRect().height;
				target.style.height = `${cur}px`;
				void target.offsetHeight;
				const card = target.closest('.proj-card') as HTMLElement | null;
				if (card) card.style.transformOrigin = 'top center';
				// Padding has to come down with the height, or the body settles at a
				// 32px sliver and sits there until the tiles finish flying home.
				// Padding is set directly and never handed to Motion. Motion retains
				// ownership of every property it has animated on an element and
				// re-applies its last value when the next animation starts, so a
				// padding keyframe here silently clobbers the reset on reopen.
				target.style.paddingTop = '0px';
				target.style.paddingBottom = '0px';
				// Not exit-scaled. `springToFloor` ends at the first zero crossing rather
				// than at full settle, so an exit-shortened spring lands earlier still
				// and the collapse reads as a fast-forward next to the ~460ms open.
				animate(target, { opacity: 0 }, transition('snappy', { delay: 0.04 }));
				bodyAnim = springToFloor(target, 'height', cur, {
					name: 'snappy',
					delay: 0.04,
					onFloor: () => {
						if (myGen !== gen) return;
						if (!isExpanded()) {
							setRenderedProjectBodies(
								new Set([...getRenderedProjectBodies()].filter((x) => x !== id))
							);
							projectBodyEls.delete(id);
						}
					}
				});
			}
		});
		return () => {
			stopReflowWatch();
			stopBodyAnim();
			projectBodyEls.delete(id);
		};
	};
}
