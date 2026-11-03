<script lang="ts">
	import {
		ArrowRight,
		Box,
		Database,
		Globe,
		MoreHorizontal,
		Server,
		Sparkles
	} from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import Verdict from './Verdict.svelte';
	import PingDot from './PingDot.svelte';

	const APPS = [
		{ name: 'hackclub-site', meta: statusMeta('success', 'Running') },
		{ name: 'scrapbook', meta: statusMeta('error', 'Crashing') },
		{ name: 'arcade-api', meta: statusMeta('success', 'Running') }
	];

	const KINDS = [
		{ icon: Globe, label: 'Web' },
		{ icon: Database, label: 'Postgres' },
		{ icon: Server, label: 'Worker' },
		{ icon: Box, label: 'Cron' }
	];
	const LOUD = ['var(--red-7)', 'var(--green-7)', 'var(--blue-7)', 'var(--amber-7)'];
</script>

<div class="grid grid-cols-2 gap-6">
	<SectionCard
		title="Gradient text"
		description="Headings are plain ink. Weight and tone carry the hierarchy."
	>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="Plain ink.">
				<span class="flex flex-col gap-1">
					<span class="text-title-2 text-fg">Deployments</span>
					<span class="text-callout text-muted">12 running in hackclub</span>
				</span>
			</Verdict>
			<Verdict kind="dont" note="Gradient fill on a heading.">
				<span class="flex flex-col gap-1">
					<span class="text-title-2 gradient-text">Deployments</span>
					<span class="text-callout gradient-text">12 running in hackclub</span>
				</span>
			</Verdict>
		</div>
	</SectionCard>

	<SectionCard
		title="Cards inside cards"
		description="Nest only when elevation means something: a sunken tray holding raised cards."
	>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="Tray, then cards.">
				<div class="tray">
					<span class="raised"></span>
					<span class="raised"></span>
				</div>
			</Verdict>
			<Verdict kind="dont" note="Border inside border.">
				<div class="boxed">
					<span class="boxed-inner"></span>
					<span class="boxed-inner"></span>
				</div>
			</Verdict>
		</div>
	</SectionCard>

	<SectionCard
		title="One radius everywhere"
		description="Containers 18, cards 14, controls 10, inner tiles derived. Nested corners stay concentric."
	>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="Tiered and concentric.">
				<div class="tier-panel">
					<div class="tier-card">
						<span class="tier-control">Deploy</span>
					</div>
				</div>
			</Verdict>
			<Verdict kind="dont" note="24 on everything.">
				<div class="tier-panel tier-panel--same">
					<div class="tier-card tier-card--same">
						<span class="tier-control tier-control--same">Deploy</span>
					</div>
				</div>
			</Verdict>
		</div>
	</SectionCard>

	<SectionCard
		title="Decorative colour"
		description="Red only means broken, amber in progress, green healthy. Kinds get glyphs, not colours."
	>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="Glyphs carry the kind.">
				<div class="flex gap-2">
					{#each KINDS as k (k.label)}
						{@const Icon = k.icon}
						<span class="glyph-tile" title={k.label}><Icon size={16} strokeWidth={1.75} /></span>
					{/each}
				</div>
			</Verdict>
			<Verdict kind="dont" note="A rainbow, and one of them is red.">
				<div class="flex gap-2">
					{#each KINDS as k, i (k.label)}
						{@const Icon = k.icon}
						<span class="glyph-tile glyph-tile--loud" style:--loud={LOUD[i]} title={k.label}
							><Icon size={16} strokeWidth={1.75} /></span
						>
					{/each}
				</div>
			</Verdict>
		</div>
	</SectionCard>

	<SectionCard
		title="Pulsing ping"
		description="Live work gets the activity ring. Radar pings and breathing halos shout about something routine."
	>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="The activity ring.">
				<span class="flex items-center gap-2">
					<StatusDot meta={statusMeta('progress', 'Building', true)} size={10} />
					<span class="text-body text-fg">Building</span>
				</span>
			</Verdict>
			<Verdict kind="dont" note="A radar ping for routine work.">
				<span class="flex items-center gap-2">
					<PingDot size={10} />
					<span class="text-body text-fg">Building</span>
				</span>
			</Verdict>
		</div>
	</SectionCard>

	<SectionCard title="Generic copy" description="Say what is true right now, in the user's terms.">
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="Specific and true.">
				<span class="flex flex-col gap-1">
					<span class="text-headline font-medium text-fg"
						>Everything is running except scrapbook</span
					>
					<span class="text-callout text-muted">It has crashed 3 times since 14:02.</span>
				</span>
			</Verdict>
			<Verdict kind="dont" note="Could be any product.">
				<span class="flex flex-col gap-1">
					<span class="flex items-center gap-1.5 text-headline font-medium text-fg">
						<Sparkles size={16} /> Welcome back!
					</span>
					<span class="text-callout text-muted">Here is an overview of your projects.</span>
				</span>
			</Verdict>
		</div>
	</SectionCard>
</div>

<SectionCard
	title="The same chrome on every item"
	description="Status in words at the top, rows quiet, per-row actions on hover. One primary action per page."
>
	<div class="grid grid-cols-2 gap-4">
		<Verdict kind="do" note="Status in words, actions on hover." align="stretch">
			<div class="list-card">
				<div class="list-head">
					<span class="text-callout font-medium text-fg">Apps</span>
					<span class="text-callout font-semibold text-error">1 failing</span>
				</div>
				{#each APPS as a, i (a.name)}
					<div class="list-row" class:list-row--pointer={i === 1}>
						<span class="min-w-0 truncate text-body text-fg">{a.name}</span>
						<StatusBadge variant="plain" meta={a.meta} />
						<span class="row-acts">
							<Button size="sm" variant="ghost" icon={ArrowRight} label="Open {a.name}" />
						</span>
					</div>
				{/each}
			</div>
		</Verdict>
		<Verdict kind="dont" note="Badges and buttons on every row." align="stretch">
			<div class="list-card">
				{#each APPS as a (a.name)}
					<div class="list-row list-row--loud">
						<span class="min-w-0 truncate text-body text-fg">{a.name}</span>
						<Badge tone={a.meta.kind === 'error' ? 'error' : 'success'}>{a.meta.label}</Badge>
						<span class="flex items-center gap-1">
							<Button size="sm" variant="primary">Open</Button>
							<Button size="sm" variant="ghost" icon={MoreHorizontal} label="More for {a.name}" />
						</span>
					</div>
				{/each}
			</div>
		</Verdict>
	</div>
</SectionCard>

<style>
	.gradient-text {
		background: linear-gradient(90deg, var(--accent-7), var(--blue-7), var(--green-7));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.tray {
		--tray-r: var(--radius-panel);
		--tray-pad: 0.5rem;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
		width: 100%;
		max-width: 13rem;
		padding: var(--tray-pad);
		border-radius: calc(var(--tray-r) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-active);
	}
	.raised {
		height: 4rem;
		border-radius: calc((var(--tray-r) - var(--tray-pad)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.boxed {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
		width: 100%;
		max-width: 13rem;
		padding: 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
	}
	.boxed-inner {
		height: 4rem;
		border: 1px solid var(--border-strong);
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
	}
	.tier-panel {
		--p-r: var(--radius-panel);
		--p-pad: 0.5rem;
		padding: var(--p-pad);
		border-radius: calc(var(--p-r) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-active);
	}
	.tier-card {
		--c-r: calc(var(--p-r) - var(--p-pad));
		--c-pad: 0.75rem;
		display: flex;
		align-items: flex-end;
		justify-content: flex-end;
		width: 11rem;
		height: 5rem;
		padding: var(--c-pad);
		border-radius: calc(var(--c-r) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.tier-control {
		display: inline-flex;
		align-items: center;
		height: 1.75rem;
		padding: 0 0.625rem;
		border-radius: calc(max(var(--radius-floor), var(--c-r) - var(--c-pad)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--accent);
		color: var(--text-on-accent);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	.tier-panel--same,
	.tier-card--same,
	.tier-control--same {
		border-radius: 1.5rem;
	}
	.glyph-tile {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		color: var(--text-muted);
	}
	.glyph-tile--loud {
		background: var(--loud);
		box-shadow: none;
		color: var(--on-solid);
	}
	.list-card {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.5rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.list-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		padding: 0.25rem 0.5rem 0.5rem;
	}
	.list-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 6rem 2rem;
		align-items: center;
		gap: 0.75rem;
		height: 2.25rem;
		padding: 0 0.125rem 0 0.5rem;
		border-radius: calc((var(--radius-card) - 0.5rem) * var(--corner-scale));
		corner-shape: var(--corner);
		transition: background-color var(--fade-in) var(--curve-out);
	}
	.list-row:hover,
	.list-row--pointer {
		background: var(--bg-hover);
	}
	.list-row--loud {
		grid-template-columns: minmax(0, 1fr) max-content max-content;
	}
	.row-acts {
		opacity: 0;
		transition: opacity var(--fade-out) var(--curve-in);
	}
	.list-row--pointer .row-acts,
	.list-row:is(:hover, :has(:focus-visible)) .row-acts {
		opacity: 1;
		transition: opacity var(--fade-in) var(--curve-out);
	}
</style>
