<script lang="ts" module>
	import type { StatusMeta } from '$lib/components/ui/status';

	export type TileApp = {
		name: string;
		kind?: 'deployment' | 'database' | 'job';
		icon?: string | null;
		status?: StatusMeta;
		detail?: string;
		url?: string;
		href?: string;
		updatedAt?: string | null;
	};

	export type TileProject = {
		id: string;
		name: string;
		href: string;
		image?: string | null;
		background?: string | null;
		summary: { tone: 'success' | 'progress' | 'error' | 'neutral'; label: string };
		apps: TileApp[];
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';
	import { ArrowRight, X } from 'lucide-svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import { bakeBlur } from '$lib/components/aura/aura';
	import { decorativeMotion, motionEnabled, springTiming } from '$lib/utils/motion.svelte';

	let {
		projects,
		open: content = undefined,
		label = 'Projects'
	}: {
		projects: TileProject[];
		open?: Snippet<[id: string]>;
		label?: string;
	} = $props();

	const PREVIEW = 4;
	const BURST_SCALE = 0.2;
	const BURST_WINDOW = 0.06;
	const STRIDE = 0.025;
	const BURST_LEAD = 0.04;
	const DRIFT = 0.35;
	const SHRINK = 0.85;
	const UNKNOWN = statusMeta('neutral', 'Unknown');

	const titleId = $props.id();
	const requested = new Set<string>();
	let meshes = $state<Record<string, string>>({});

	$effect(() => {
		for (const p of projects) {
			if (!p.background || requested.has(p.id)) continue;
			requested.add(p.id);
			const id = p.id;
			bakeBlur(p.background).then((url) => {
				if (url) meshes[id] = url;
			});
		}
	});

	const tileEls: Record<string, HTMLElement> = $state({});
	let activeId = $state<string | null>(null);
	let awayId = $state<string | null>(null);
	const active = $derived(projects.find((p) => p.id === activeId) ?? null);

	let dialogEl = $state<HTMLDialogElement>();
	let panelEl = $state<HTMLElement>();
	let surfaceEl = $state<HTMLElement>();
	let ghostEl = $state<HTMLElement>();
	let iconEl = $state<HTMLElement>();
	let nameEl = $state<HTMLElement>();
	let appsEl = $state<HTMLElement>();
	let scrimEl = $state<HTMLElement>();

	let phase: 'idle' | 'open' | 'closing' = 'idle';
	let session = 0;
	let rest: { icon: DOMRect; name: DOMRect } | null = null;
	const vectors = new WeakMap<Element, { x: number; y: number }>();
	const running = new Map<Element, Map<string, Animation>>();

	function play(
		el: Element | undefined,
		from: Keyframe,
		to: Keyframe,
		timing: KeyframeAnimationOptions
	) {
		if (!el) return null;
		const key = Object.keys(to).sort().join();
		let slots = running.get(el);
		if (!slots) running.set(el, (slots = new Map()));
		const prev = slots.get(key);
		let start = from;
		if (prev) {
			const cs = getComputedStyle(el);
			start = Object.fromEntries(
				Object.keys(to).map((k) => [k, cs.getPropertyValue(k)])
			);
			prev.cancel();
		}
		const anim = el.animate([start, to], { ...timing, fill: 'both' });
		slots.set(key, anim);
		return anim;
	}

	function releaseAll() {
		for (const slots of running.values()) for (const a of slots.values()) a.cancel();
		running.clear();
	}

	const rectTransform = (from: DOMRect, to: DOMRect) =>
		`translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;

	const shareTransform = (from: DOMRect | undefined, to: DOMRect) =>
		from
			? `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.height / to.height})`
			: 'none';

	const part = (tile: HTMLElement | undefined, name: string) =>
		tile?.querySelector<HTMLElement>(`[data-part="${name}"]`)?.getBoundingClientRect();

	const extras = () => [...(panelEl?.querySelectorAll<HTMLElement>('[data-extra]') ?? [])];
	const appTiles = () => [...(appsEl?.querySelectorAll<HTMLElement>(':scope > *') ?? [])];

	async function show(id: string) {
		if (activeId) return;
		const token = ++session;
		activeId = id;
		phase = 'open';
		await tick();
		if (token !== session || !dialogEl) return;
		dialogEl.showModal();
		panelEl?.focus({ preventScroll: true });
		runOpen(id);
	}

	function runOpen(id: string) {
		const tile = tileEls[id];
		if (!motionEnabled() || !tile || !panelEl || !iconEl || !nameEl) return;
		const full = decorativeMotion();
		const T = tile.getBoundingClientRect();
		const P = panelEl.getBoundingClientRect();
		const icon = iconEl.getBoundingClientRect();
		rest = { icon, name: nameEl.getBoundingClientRect() };
		const ox = icon.left + icon.width / 2;
		const oy = icon.top + icon.height / 2;
		const apps = appTiles();
		for (const el of apps) {
			const r = el.getBoundingClientRect();
			vectors.set(el, { x: ox - (r.left + r.width / 2), y: oy - (r.top + r.height / 2) });
		}
		const distance = Math.hypot(T.left - P.left, T.top - P.top);
		const morph = springTiming('smooth', { distance });
		const quick = springTiming('snappy');

		if (full) awayId = id;
		if (ghostEl) {
			ghostEl.style.width = `${T.width}px`;
			ghostEl.style.height = `${T.height}px`;
			ghostEl.style.visibility = full ? '' : 'hidden';
		}
		play(scrimEl, { opacity: '0' }, { opacity: '1' }, morph);
		play(surfaceEl, { opacity: '0' }, { opacity: '1' }, quick);
		if (full) {
			play(surfaceEl, { transform: rectTransform(T, P) }, { transform: 'none' }, morph);
			play(
				ghostEl,
				{ transform: `translate(${T.left - P.left}px, ${T.top - P.top}px)` },
				{ transform: `scale(${P.width / T.width}, ${P.height / T.height})` },
				morph
			);
			play(iconEl, { transform: shareTransform(part(tile, 'icon'), rest.icon) }, { transform: 'none' }, morph);
			play(nameEl, { transform: shareTransform(part(tile, 'name'), rest.name) }, { transform: 'none' }, morph);
		}
		for (const el of extras()) {
			play(el, { opacity: '0' }, { opacity: '1' }, springTiming('snappy', { delay: BURST_LEAD * 2 }));
		}
		const stride = apps.length > 1 ? Math.min(STRIDE, BURST_WINDOW / (apps.length - 1)) : 0;
		apps.forEach((el, i) => {
			const v = vectors.get(el) ?? { x: 0, y: 0 };
			const away = full ? `translate(${v.x}px, ${v.y}px) scale(${BURST_SCALE})` : 'none';
			play(
				el,
				{ transform: away, opacity: '0' },
				{ transform: 'none', opacity: '1' },
				springTiming('snappy', { delay: BURST_LEAD + i * stride })
			);
		});
	}

	function hide() {
		if (!activeId || phase !== 'open') return;
		phase = 'closing';
		const token = session;
		const tile = tileEls[activeId];
		const finish = () => {
			if (token !== session) return;
			session++;
			phase = 'idle';
			releaseAll();
			if (dialogEl?.open) dialogEl.close();
			activeId = null;
			const wasAway = awayId;
			awayId = null;
			rest = null;
			if (wasAway && tile && decorativeMotion()) {
				for (const el of tile.querySelectorAll<HTMLElement>('[data-fade]')) {
					el.animate([{ opacity: 0 }, { opacity: 1 }], springTiming('snappy'));
				}
			}
		};
		if (!motionEnabled() || !tile || !panelEl || !rest) return finish();
		const full = decorativeMotion() && awayId !== null;
		const T = tile.getBoundingClientRect();
		const P = panelEl.getBoundingClientRect();
		const distance = Math.hypot(T.left - P.left, T.top - P.top);
		const morph = springTiming('smooth', { exit: true, distance });
		const quick = springTiming('snappy', { exit: true });

		for (const el of appTiles()) {
			const v = vectors.get(el) ?? { x: 0, y: 0 };
			const near = full
				? `translate(${v.x * DRIFT}px, ${v.y * DRIFT}px) scale(${SHRINK})`
				: 'none';
			play(el, { transform: 'none', opacity: '1' }, { transform: near, opacity: '0' }, quick);
		}
		for (const el of extras()) play(el, { opacity: '1' }, { opacity: '0' }, quick);
		play(scrimEl, { opacity: '1' }, { opacity: '0' }, morph);

		let done: Animation | null;
		if (full) {
			play(surfaceEl, { opacity: '1' }, { opacity: '0' }, quick);
			done = play(surfaceEl, { transform: 'none' }, { transform: rectTransform(T, P) }, morph);
			play(
				ghostEl,
				{ transform: `scale(${P.width / T.width}, ${P.height / T.height})` },
				{ transform: `translate(${T.left - P.left}px, ${T.top - P.top}px)` },
				morph
			);
			play(iconEl, { transform: 'none' }, { transform: shareTransform(part(tile, 'icon'), rest.icon) }, morph);
			play(nameEl, { transform: 'none' }, { transform: shareTransform(part(tile, 'name'), rest.name) }, morph);
		} else {
			done = play(surfaceEl, { opacity: '1' }, { opacity: '0' }, morph);
		}
		if (!done) return finish();
		done.finished.then(finish, () => {});
	}

	function onCancel(e: Event) {
		e.preventDefault();
		hide();
	}

	function onClosed() {
		if (phase === 'idle') return;
		session++;
		phase = 'idle';
		releaseAll();
		activeId = null;
		awayId = null;
		rest = null;
	}
</script>

{#snippet art(p: TileProject)}
	{#if p.background}
		<span
			class="mesh-host"
			class:mesh-host--ready={!!meshes[p.id]}
			style:--mesh={meshes[p.id] ? `url("${meshes[p.id]}")` : 'none'}
		>
			<span class="mesh mesh--1"></span>
			<span class="mesh mesh--2"></span>
			<span class="veil"></span>
		</span>
	{:else}
		<span class="calm"></span>
	{/if}
{/snippet}

{#snippet summaryOf(p: TileProject)}
	<span class="sum sum--{p.summary.tone}"
		><span class="sum-dot"></span><span class="sum-label">{p.summary.label}</span></span
	>
{/snippet}

<div class="tiles" role="list" aria-label={label}>
	{#each projects as p (p.id)}
		{@const shown = p.apps.slice(0, PREVIEW)}
		{@const more = p.apps.length - shown.length}
		<div class="slot" role="listitem">
			<button
				type="button"
				class="tile"
				class:tile--media={!!p.background}
				class:tile--away={awayId === p.id}
				bind:this={tileEls[p.id]}
				aria-haspopup="dialog"
				aria-expanded={activeId === p.id}
				aria-label="{p.name}, {p.summary.label}, {p.apps.length} {p.apps.length === 1
					? 'app'
					: 'apps'}"
				onclick={() => show(p.id)}
			>
				<span class="lift" aria-hidden="true"></span>
				<span class="art" aria-hidden="true">{@render art(p)}</span>
				<span class="top">
					<span class="tile-icon" data-part="icon"
						><AppIcon name={p.name} kind="project" icon={p.image} size="lg" /></span
					>
					<span data-fade>{@render summaryOf(p)}</span>
				</span>
				<span class="foot">
					<span class="tile-name" data-part="name">{p.name}</span>
					<span class="preview" data-fade aria-label="{p.apps.length} apps">
						{#each shown as a (a.name)}
							<AppIcon name={a.name} kind={a.kind ?? 'deployment'} icon={a.icon} size="xs" />
						{/each}
						{#if more > 0}<span class="more">+{more}</span>{/if}
					</span>
				</span>
			</button>
		</div>
	{/each}
</div>

{#if active}
	<dialog
		bind:this={dialogEl}
		class="host"
		aria-labelledby={titleId}
		oncancel={onCancel}
		onclose={onClosed}
	>
		<div class="stage">
			<div
				bind:this={panelEl}
				class="panel"
				class:panel--media={!!active.background}
				tabindex="-1"
			>
				<div bind:this={ghostEl} class="ghost" aria-hidden="true">{@render art(active)}</div>
				<div bind:this={surfaceEl} class="surface" aria-hidden="true">
					{#if active.background}<span class="surface-art">{@render art(active)}</span>{/if}
				</div>
				<header class="phead">
					<span class="panel-icon" bind:this={iconEl}
						><AppIcon name={active.name} kind="project" icon={active.image} size="lg" /></span
					>
					<span class="ptext">
						<h2 class="panel-name" id={titleId} bind:this={nameEl}>{active.name}</h2>
						<span class="pmeta" data-extra>
							{@render summaryOf(active)}
							<span class="sep" aria-hidden="true"></span>
							<span class="count"
								>{active.apps.length} {active.apps.length === 1 ? 'app' : 'apps'}</span
							>
						</span>
					</span>
					<span class="pactions" data-extra>
						<a class="round" href={active.href} aria-label="Open {active.name}"
							><ArrowRight size={15} /></a
						>
						<button type="button" class="round" aria-label="Close" onclick={hide}
							><X size={15} /></button
						>
					</span>
				</header>
				<div class="apps" role="list" bind:this={appsEl}>
					{#if content}
						{@render content(active.id)}
					{:else}
						{#each active.apps as a (a.name)}
							<EntityRow
								kind={a.kind ?? 'deployment'}
								name={a.name}
								status={a.status ?? UNKNOWN}
								href={a.href ?? active.href}
								url={a.url}
								detail={a.detail}
								updatedAt={a.updatedAt}
								image={a.icon}
							/>
						{/each}
					{/if}
				</div>
			</div>
		</div>
		<button
			bind:this={scrimEl}
			type="button"
			class="scrim"
			tabindex="-1"
			aria-label="Close {active.name}"
			onclick={hide}
		></button>
	</dialog>
{/if}

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 1rem;
	}
	.slot {
		display: flex;
		min-width: 0;
	}
	.tile {
		--t-fg: var(--text-default);
		--t-muted: var(--text-muted);
		--t-chip: color-mix(in oklab, var(--neutral-10) 7%, transparent);
		position: relative;
		display: flex;
		flex: 1;
		flex-direction: column;
		justify-content: space-between;
		min-width: 0;
		aspect-ratio: 4 / 3;
		padding: 1rem;
		border: none;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: none;
		color: var(--t-fg);
		font: inherit;
		text-align: left;
		cursor: pointer;
		isolation: isolate;
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.tile--media {
		--t-fg: var(--on-media);
		--t-muted: var(--on-media-muted);
		--t-chip: var(--on-media-fill);
	}
	.tile:hover {
		transform: scale(1.025);
	}
	.tile:active {
		transform: scale(0.97);
		transition-duration: var(--spring-interactive-duration);
		transition-timing-function: var(--spring-interactive);
	}
	.tile--away {
		opacity: 0;
	}
	.tile:focus-visible {
		outline: none;
	}
	.tile:focus-visible .lift {
		opacity: 1;
		box-shadow:
			0 0 0 3px var(--focus-ring),
			var(--shadow-floating);
	}
	.lift {
		position: absolute;
		inset: 0;
		z-index: -2;
		border-radius: inherit;
		corner-shape: var(--corner);
		box-shadow: var(--shadow-floating);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.tile:hover .lift {
		opacity: 1;
	}
	.art {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: clip;
		border-radius: inherit;
		corner-shape: var(--corner);
		box-shadow: var(--shadow-raised);
		background: var(--bg-raised);
	}
	.art > :global(*) {
		transition: transform var(--spring-smooth-duration) var(--spring-smooth);
	}
	.tile:hover .art > :global(*) {
		transform: scale(1.04);
	}

	.calm {
		position: absolute;
		inset: 0;
		background:
			radial-gradient(
				120% 90% at 0% 0%,
				var(--neutral-3),
				transparent 70%
			),
			linear-gradient(180deg, var(--bg-raised), var(--neutral-2));
	}
	.mesh-host {
		position: absolute;
		inset: 0;
		overflow: hidden;
		background: var(--bg-active);
		contain: paint;
	}
	.mesh {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 200%;
		aspect-ratio: 1;
		background-image: var(--mesh);
		background-size: cover;
		background-position: center;
		opacity: 0;
		transition: opacity 500ms ease-out;
	}
	.mesh--1 {
		transform: translate(-50%, -50%) scale(1.15);
	}
	.mesh--2 {
		transform: translate(-50%, -50%) scale(1.6) rotate(110deg);
	}
	.mesh-host--ready .mesh--1 {
		opacity: 0.95;
	}
	.mesh-host--ready .mesh--2 {
		opacity: 0.5;
	}
	.veil {
		position: absolute;
		inset: 0;
		background:
			linear-gradient(
				180deg,
				var(--on-media-pill) 0%,
				transparent 38%,
				transparent 50%,
				var(--on-media-pill) 100%
			),
			var(--media-veil);
	}

	.top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		min-width: 0;
	}
	.tile-icon {
		display: flex;
		flex-shrink: 0;
		border-radius: calc(0.6875rem * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: 0 1px 3px color-mix(in oklab, var(--neutral-10) 14%, transparent);
	}
	.foot {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.tile-name {
		display: block;
		width: fit-content;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.01em;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.tile--media .tile-name {
		text-shadow: var(--on-media-shadow);
	}
	.preview {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}
	.more {
		display: grid;
		place-items: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding-inline: 0.25rem;
		border-radius: calc(0.3125rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--t-chip);
		color: var(--t-muted);
		font-size: var(--text-micro);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}

	.sum {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		color: var(--t-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.sum-label {
		text-box: trim-both cap alphabetic;
	}
	.sum-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--neutral-6);
	}
	.sum--success .sum-dot {
		background: var(--green-6);
	}
	.sum--progress .sum-dot {
		background: var(--amber-6);
	}
	.sum--error .sum-dot {
		background: var(--red-6);
	}
	.sum--error {
		color: var(--t-fg);
		font-weight: var(--weight-semibold);
	}
	.tile:not(.tile--media) .sum--error,
	.panel:not(.panel--media) .sum--error {
		color: var(--status-error);
	}
	.top .sum {
		margin-top: 0.25rem;
	}

	.host {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-default);
		overflow: auto;
		overscroll-behavior: contain;
	}
	.host::backdrop {
		background: none;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 0;
		padding: 0;
		border: none;
		background: var(--on-media-pill);
		backdrop-filter: blur(24px) saturate(1.3);
		cursor: default;
	}
	.stage {
		position: relative;
		z-index: 1;
		display: flex;
		min-height: 100%;
		padding: 2.5rem 1rem;
		pointer-events: none;
	}
	.panel {
		--p-fg: var(--text-default);
		--p-muted: var(--text-muted);
		--p-fill: color-mix(in oklab, var(--neutral-10) 6%, transparent);
		--p-fill-hover: color-mix(in oklab, var(--neutral-10) 11%, transparent);
		--t-fg: var(--p-fg);
		--t-muted: var(--p-muted);
		--phead-h: 5.25rem;
		position: relative;
		width: min(40rem, 100%);
		margin: auto;
		isolation: isolate;
		pointer-events: auto;
	}
	.panel:focus {
		outline: none;
	}
	.panel--media {
		--p-fg: var(--on-media);
		--p-muted: var(--on-media-muted);
		--p-fill: var(--on-media-fill);
		--p-fill-hover: var(--on-media-fill-hover);
	}
	.ghost {
		position: absolute;
		top: 0;
		left: 0;
		z-index: -2;
		overflow: clip;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: var(--shadow-overlay);
		transform-origin: 0 0;
		pointer-events: none;
	}
	.surface {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: clip;
		border-radius: calc(var(--radius-panel) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: var(--shadow-overlay);
		transform-origin: 0 0;
	}
	.surface-art {
		position: absolute;
		inset: 0 0 auto;
		height: var(--phead-h);
	}
	.phead {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		height: var(--phead-h);
		padding: 0 1rem 0 1.25rem;
		color: var(--p-fg);
	}
	.panel:not(.panel--media) .phead {
		box-shadow: inset 0 -1px 0 var(--border-default);
	}
	.panel-icon {
		display: flex;
		flex-shrink: 0;
		transform-origin: 0 0;
		border-radius: calc(0.6875rem * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: 0 1px 3px color-mix(in oklab, var(--neutral-10) 14%, transparent);
	}
	.ptext {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.625rem;
		min-width: 0;
	}
	.panel-name {
		width: fit-content;
		max-width: 100%;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transform-origin: 0 0;
		font-size: var(--text-title-2);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.014em;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.panel--media .panel-name {
		text-shadow: var(--on-media-shadow);
	}
	.pmeta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--p-muted);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.count {
		text-box: trim-both cap alphabetic;
	}
	.sep {
		width: 2px;
		height: 2px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--p-muted);
	}
	.pactions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}
	.round {
		display: inline-grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: var(--p-fill);
		color: var(--p-fg);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.round:hover {
		background: var(--p-fill-hover);
	}
	.apps {
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
	}
	.panel .apps > :global(*) {
		content-visibility: visible;
	}
</style>
