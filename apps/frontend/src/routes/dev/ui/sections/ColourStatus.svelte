<script lang="ts">
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import { statusMeta, type StatusKind } from '$lib/components/ui/status';
	import Verdict from './Verdict.svelte';
	import PingDot from './PingDot.svelte';

	const MEANINGS = [
		{
			name: 'Neutral',
			swatch: 'var(--neutral-3)',
			means: 'Every surface, border and line of text. Tinted by the theme.'
		},
		{
			name: 'Accent',
			swatch: 'var(--accent)',
			means: 'The one thing to press, focus and selection.'
		},
		{ name: 'Green', swatch: 'var(--status-success-solid)', means: 'Healthy. Nothing else.' },
		{ name: 'Amber', swatch: 'var(--status-progress-solid)', means: 'In progress or degraded.' },
		{ name: 'Red', swatch: 'var(--status-error-solid)', means: 'Broken. Never decoration.' },
		{ name: 'Blue', swatch: 'var(--status-info-solid)', means: 'Information and queued work.' }
	];

	const KINDS: { kind: StatusKind; label: string; means: string; live?: boolean }[] = [
		{ kind: 'success', label: 'Running', means: 'Healthy' },
		{ kind: 'progress', label: 'Building', means: 'In flight', live: true },
		{ kind: 'warning', label: 'Unhealthy', means: 'Degraded' },
		{ kind: 'error', label: 'Crashing', means: 'Broken' },
		{ kind: 'info', label: 'Queued', means: 'Waiting' },
		{ kind: 'neutral', label: 'Stopped', means: 'Off on purpose' }
	];

	const PODS = [
		{ name: 'web-7d9f', meta: statusMeta('success', 'Running') },
		{ name: 'web-2c41', meta: statusMeta('error', 'Crashing') },
		{ name: 'worker-88a', meta: statusMeta('warning', 'Unhealthy') },
		{ name: 'cron-1f0e', meta: statusMeta('neutral', 'Stopped') }
	];
</script>

<div class="grid grid-cols-[2fr_3fr] gap-6">
	<SectionCard
		title="Colour means something"
		description="Neutral surfaces, one accent, and status colours only for status."
	>
		<ul class="meanings">
			{#each MEANINGS as m (m.name)}
				<li class="meaning">
					<span class="swatch" style:background={m.swatch}></span>
					<span class="text-body text-fg">{m.name}</span>
					<span class="text-callout text-muted">{m.means}</span>
				</li>
			{/each}
		</ul>
	</SectionCard>

	<SectionCard
		title="Every status, every form"
		description="Always through ui/status.ts. Quiet when healthy, the activity ring only while something is in flight."
	>
		<div class="kinds">
			<span class="kinds-head">Means</span>
			<span class="kinds-head">Dot</span>
			<span class="kinds-head">Plain</span>
			<span class="kinds-head">Subtle</span>
			<span class="kinds-head">Solid</span>
			{#each KINDS as k (k.kind)}
				{@const meta = statusMeta(k.kind, k.label, k.live)}
				<span class="text-callout text-muted">{k.means}</span>
				<span class="flex"><StatusDot {meta} /></span>
				<span class="flex"><StatusBadge variant="plain" {meta} /></span>
				<span class="flex"><StatusBadge {meta} /></span>
				<span class="flex"><StatusBadge variant="solid" meta={statusMeta(k.kind, k.label)} /></span>
			{/each}
		</div>
	</SectionCard>
</div>

<div class="grid grid-cols-2 gap-6">
	<SectionCard
		title="Never colour alone"
		description="A dot is a hint. The word is the status, so it reads without colour vision and in a screenshot."
	>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="StatusDot plus its label." align="stretch">
				<div class="pods">
					{#each PODS as p (p.name)}
						<div class="pod">
							<span class="font-mono text-callout text-fg">{p.name}</span>
							<StatusBadge variant="plain" meta={p.meta} />
						</div>
					{/each}
				</div>
			</Verdict>
			<Verdict kind="dont" note="Which one is broken?" align="stretch">
				<div class="pods">
					{#each PODS as p (p.name)}
						<div class="pod">
							<span class="font-mono text-callout text-fg">{p.name}</span>
							<StatusDot meta={p.meta} />
						</div>
					{/each}
				</div>
			</Verdict>
		</div>
	</SectionCard>

	<SectionCard
		title="Live status"
		description="In progress shows a tiny activity ring: solid core, thin ring, a short arc orbiting it. Healthy dots are still. The ring keeps turning at reduced motion because it is a progress indicator."
	>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="Activity ring.">
				<div class="flex flex-col items-start gap-3">
					<span class="flex items-center gap-2">
						<StatusDot meta={statusMeta('progress', 'Building', true)} size={10} />
						<span class="text-body text-fg">Building</span>
					</span>
					<span class="flex items-center gap-2">
						<StatusDot meta={statusMeta('success', 'Running')} size={10} />
						<span class="text-body text-fg">Running</span>
					</span>
				</div>
			</Verdict>
			<Verdict kind="dont" note="Radar ping and pulsing halos.">
				<div class="flex flex-col items-start gap-3">
					<span class="flex items-center gap-2">
						<PingDot size={10} />
						<span class="text-body text-fg">Building</span>
					</span>
					<span class="flex items-center gap-2">
						<PingDot size={10} />
						<span class="text-body text-fg">Running</span>
					</span>
				</div>
			</Verdict>
		</div>
	</SectionCard>
</div>

<SectionCard
	title="Red only means broken"
	description="Destructive actions and failures are the only red on a screen. Identity colours never use it."
>
	<div class="grid grid-cols-2 gap-4">
		<Verdict kind="do" note="Neutral by default, red where something is wrong.">
			<div class="flex items-center gap-3">
				<Button size="sm">Redeploy</Button>
				<Button size="sm" variant="danger">Delete app</Button>
				<StatusBadge meta={statusMeta('error', '1 failing')} />
			</div>
		</Verdict>
		<Verdict kind="dont" note="Red as decoration trains people to ignore it.">
			<div class="flex items-center gap-3">
				<span class="loud-tile">Redeploy</span>
				<span class="loud-tile loud-tile--alt">Logs</span>
				<span class="loud-tile loud-tile--alt2">Settings</span>
			</div>
		</Verdict>
	</div>
</SectionCard>

<style>
	.meanings {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.meaning {
		display: grid;
		grid-template-columns: 1.25rem 4.5rem minmax(0, 1fr);
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0;
		border-top: 1px solid var(--rule);
	}
	.meaning:first-child {
		padding-top: 0;
		border-top: none;
	}
	.meaning:last-child {
		padding-bottom: 0;
	}
	.swatch {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 12%, transparent);
	}
	.kinds {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 2.5rem repeat(3, max-content);
		align-items: center;
		column-gap: 1.5rem;
		row-gap: 0.75rem;
	}
	.kinds-head {
		color: var(--text-faint);
		font-size: var(--text-caption);
	}
	.pods {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.pod {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 6rem;
		align-items: center;
		gap: 0.75rem;
	}
	.loud-tile {
		display: inline-flex;
		align-items: center;
		height: 2rem;
		padding: 0 0.75rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--red-7);
		color: var(--on-solid);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
	.loud-tile--alt {
		background: var(--green-7);
	}
	.loud-tile--alt2 {
		background: var(--blue-7);
	}
</style>
