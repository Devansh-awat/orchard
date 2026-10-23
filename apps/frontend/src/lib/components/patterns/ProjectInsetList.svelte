<script lang="ts" module>
	import type { StatusMeta } from '$lib/components/ui/status';

	export type InsetApp = {
		name: string;
		kind?: 'deployment' | 'database' | 'job';
		icon?: string | null;
		status?: StatusMeta;
		detail?: string;
		href?: string;
	};

	export type InsetProject = {
		id: string;
		name: string;
		href: string;
		image?: string | null;
		background?: string | null;
		summary: { tone: 'success' | 'progress' | 'error' | 'neutral'; label: string };
		apps: InsetApp[];
	};
</script>

<script lang="ts">
	import { ArrowRight, ChevronRight } from 'lucide-svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { folder } from '$lib/utils/motion.svelte';

	let {
		projects,
		expanded = $bindable([]),
		label = 'Projects'
	}: {
		projects: InsetProject[];
		expanded?: string[];
		label?: string;
	} = $props();

	const uid = $props.id();
	const icons: Record<string, HTMLElement> = $state({});

	const isOpen = (id: string) => expanded.includes(id);

	function toggle(id: string) {
		expanded = isOpen(id) ? expanded.filter((x) => x !== id) : [...expanded, id];
	}

	const quiet = (s?: StatusMeta) => !s || s.kind === 'success' || s.kind === 'neutral';
</script>

<div class="inset" role="list" aria-label={label}>
	{#each projects as p (p.id)}
		<div class="item" role="listitem">
			<div class="prow" class:prow--open={isOpen(p.id)}>
				<button
					type="button"
					class="hit"
					aria-expanded={isOpen(p.id)}
					aria-controls="{uid}-{p.id}"
					aria-label="{p.name}, {p.summary.label}"
					onclick={() => toggle(p.id)}
				></button>
				<span class="picon" bind:this={icons[p.id]}
					><AppIcon name={p.name} kind="project" icon={p.image} size="md" /></span
				>
				<span class="ptext">
					<span class="pname">{p.name}</span>
					<span class="pcount">{p.apps.length} {p.apps.length === 1 ? 'app' : 'apps'}</span>
				</span>
				<span class="sum sum--{p.summary.tone}"
					><span class="sum-dot"></span><span class="sum-label">{p.summary.label}</span></span
				>
				<a class="go" href={p.href} aria-label="Open {p.name}"><ArrowRight size={14} /></a>
				<span class="chev" aria-hidden="true"><ChevronRight size={16} /></span>
			</div>
			<div
				class="sub"
				id="{uid}-{p.id}"
				{@attach folder(() => isOpen(p.id), { origin: () => icons[p.id] })}
			>
				<div class="sub-list">
					{#each p.apps as a (a.name)}
						<a class="srow" href={a.href ?? p.href}>
							<AppIcon name={a.name} kind={a.kind ?? 'deployment'} icon={a.icon} size="sm" />
							<span class="stext">
								<span class="sname">{a.name}</span>
								{#if a.detail}<span class="sdetail">{a.detail}</span>{/if}
							</span>
							{#if a.status}
								<span class="sstate sstate--{a.status.kind}" class:sstate--loud={!quiet(a.status)}
									><StatusDot meta={a.status} size={7} /><span class="sstate-label"
										>{a.status.label}</span
									></span
								>
							{/if}
						</a>
					{/each}
				</div>
			</div>
		</div>
	{/each}
</div>

<style>
	.inset {
		--pad: 1rem;
		--icon: 2.25rem;
		--gap: 0.875rem;
		--indent: calc(var(--pad) + var(--icon) + var(--gap));
		--sicon: 1.5rem;
		--sgap: 0.75rem;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: clip;
		border-radius: calc(var(--radius-panel) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: var(--shadow-raised);
	}
	.item {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.prow {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--gap);
		min-height: 3.5rem;
		padding: 0.625rem var(--pad);
		transition: background-color var(--dur-fast) ease;
	}
	.prow:hover {
		background: var(--bg-hover);
	}
	.item + .item .prow::before,
	.srow::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: var(--indent);
		height: 1px;
		background: var(--border-default);
		pointer-events: none;
	}
	.hit {
		position: absolute;
		inset: 0;
		z-index: 0;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring-color);
	}
	.picon,
	.ptext,
	.sum,
	.chev {
		position: relative;
		pointer-events: none;
	}
	.picon {
		display: flex;
		flex-shrink: 0;
	}
	.ptext {
		display: flex;
		flex: 1;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
		white-space: nowrap;
	}
	.pname {
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--text-body);
		font-weight: var(--weight-semibold);
		color: var(--text-default);
	}
	.pcount {
		flex-shrink: 0;
		font-size: var(--text-callout);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.sum {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: var(--text-callout);
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
		color: var(--status-error);
		font-weight: var(--weight-semibold);
	}
	.go {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		margin-inline: -0.25rem -0.5rem;
		border-radius: 50%;
		color: var(--text-muted);
		opacity: 0;
		transition:
			opacity var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}
	.prow:hover .go,
	.go:focus-visible {
		opacity: 1;
	}
	.go:hover {
		background: var(--bg-active);
		color: var(--text-default);
	}
	@media (hover: none) {
		.go {
			opacity: 1;
		}
	}
	.chev {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.25rem;
		margin-right: -0.25rem;
		color: var(--text-faint);
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.prow--open .chev {
		transform: rotate(90deg);
	}

	.sub-list {
		display: flex;
		flex-direction: column;
	}
	.srow {
		--indent: calc(var(--pad) + var(--icon) + var(--gap) + var(--sicon) + var(--sgap));
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--sgap);
		min-height: 2.75rem;
		padding: 0.5rem var(--pad) 0.5rem calc(var(--pad) + var(--icon) + var(--gap));
		color: var(--text-default);
		text-decoration: none;
		transition: background-color var(--dur-fast) ease;
	}
	.srow:first-child::before {
		left: calc(var(--pad) + var(--icon) + var(--gap));
	}
	.srow:hover {
		background: var(--bg-hover);
	}
	.srow:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring-color);
	}
	.stext {
		display: flex;
		flex: 1;
		align-items: baseline;
		gap: 0.625rem;
		min-width: 0;
		white-space: nowrap;
	}
	.sname {
		flex-shrink: 0;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
	.sdetail {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.sstate {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		flex-shrink: 0;
		color: var(--text-faint);
		font-size: var(--text-caption);
		white-space: nowrap;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.sstate-label {
		text-box: trim-both cap alphabetic;
	}
	.sstate--loud {
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.sstate--error {
		color: var(--status-error);
	}
</style>
