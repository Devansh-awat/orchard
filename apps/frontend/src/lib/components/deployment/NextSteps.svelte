<script lang="ts">
	import { X, ChevronRight, Zap, Globe, Gauge, Bell, HeartPulse, Terminal } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import { apiFetch } from '$lib/stores';
	import { dismissedSteps, dismissStep, dismissAllSteps } from '$lib/stores/checklist';
	import { SectionCard, Eyebrow } from '$lib/components/ui';
	import CliModal from '$lib/components/CliModal.svelte';

	let {
		deploymentId,
		ready = false,
		onGoToTab,
		onGoToSettings
	}: {
		deploymentId: string;
		ready?: boolean;
		onGoToTab?: (tab: string) => void;
		onGoToSettings?: (section: string) => void;
	} = $props();

	type Step = { id: string; applicable: boolean; done: boolean };

	const COPY: Record<
		string,
		{
			title: string;
			hint: string;
			icon: typeof Zap;
			tab?: string;
			settings?: string;
		}
	> = {
		'auto-deploy': {
			title: 'Deploy on push',
			hint: 'Build on every push',
			icon: Zap,
			settings: 'source'
		},
		domain: {
			title: 'Add your domain',
			hint: 'Certificate included',
			icon: Globe,
			tab: 'network'
		},
		resources: {
			title: 'Set CPU and memory',
			hint: 'Running on the org default',
			icon: Gauge,
			settings: 'resources'
		},
		notifications: {
			title: 'Get alerted',
			hint: 'Slack, Discord, webhook, email',
			icon: Bell,
			settings: 'notifications'
		},
		'health-check': {
			title: 'Add a health check',
			hint: 'So a bad deploy never rolls out',
			icon: HeartPulse,
			settings: 'health'
		},
		cli: {
			title: 'Use the terminal',
			hint: 'Deploy, logs and scale',
			icon: Terminal
		}
	};

	let steps = $state<Step[]>([]);
	let dismissed = $state<string[]>([]);
	let cliOpen = $state(false);
	let fetchedFor = '';

	const visible = $derived(
		steps.filter((s) => s.applicable && !s.done && !dismissed.includes(s.id) && COPY[s.id])
	);

	$effect(() => {
		if (!ready || !deploymentId || fetchedFor === deploymentId) return;
		fetchedFor = deploymentId;
		dismissed = dismissedSteps(deploymentId);
		void load(deploymentId);
	});

	async function load(id: string) {
		try {
			const res = await apiFetch(`/apiv1/deployments/${id}/next-steps`);
			if (!res.ok) return;
			const data = await res.json();
			steps = data.steps ?? [];
		} catch {
			/* a nudge, not a feature */
		}
	}

	function act(step: Step) {
		const copy = COPY[step.id];
		if (step.id === 'cli') {
			cliOpen = true;
			return;
		}
		if (copy.settings) onGoToSettings?.(copy.settings);
		else if (copy.tab) onGoToTab?.(copy.tab);
	}

	function hide(stepId: string) {
		dismissStep(deploymentId, stepId, stepId === 'cli');
		dismissed = [...dismissed, stepId];
	}

	function hideAll() {
		const ids = visible.map((s) => s.id);
		dismissAllSteps(deploymentId, ids);
		if (ids.includes('cli')) dismissStep(deploymentId, 'cli', true);
		dismissed = [...dismissed, ...ids];
	}
</script>

{#if visible.length > 0}
	<SectionCard class="ns">
		<div class="ns-head">
			<Eyebrow>Next up</Eyebrow>
			<button class="ns-dismiss-all" type="button" onclick={hideAll}>Dismiss all</button>
		</div>
		<ul class="ns-list">
			{#each visible as step, i (step.id)}
				{@const copy = COPY[step.id]}
				<li
					class="ns-item"
					transition:slide={{ duration: 160 }}
					{@attach motionStagger({ index: i, from: { y: 6 } })}
				>
					<button class="ns-row" type="button" onclick={() => act(step)}>
						<span class="ns-icon" aria-hidden="true"><copy.icon class="h-4 w-4" /></span>
						<span class="ns-text">
							<span class="ns-title">{copy.title}</span>
							<span class="ns-hint">{copy.hint}</span>
						</span>
						<ChevronRight class="ns-chevron h-3.5 w-3.5" />
					</button>
					<button
						class="ns-hide"
						type="button"
						onclick={() => hide(step.id)}
						aria-label={`Dismiss ${copy.title}`}
					>
						<X class="h-3 w-3" />
					</button>
				</li>
			{/each}
		</ul>
	</SectionCard>
{/if}

<CliModal bind:open={cliOpen} />

<style>
	:global(.ns) {
		padding: var(--space-3) !important;
		flex-shrink: 0;
	}
	.ns-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: 0 var(--space-2) var(--space-2);
	}
	.ns-dismiss-all {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}
	.ns-dismiss-all:hover {
		color: var(--text-muted);
	}
	.ns-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ns-item {
		position: relative;
		display: flex;
		align-items: center;
	}
	.ns-row {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
		padding: 0.375rem var(--space-2);
		border: none;
		background: none;
		border-radius: var(--radius-md);
		text-align: left;
		cursor: pointer;
		color: var(--text-default);
		transition: background-color var(--dur-fast);
	}
	.ns-row:hover,
	.ns-row:focus-visible {
		background-color: var(--bg-hover);
	}
	.ns-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		color: var(--text-muted);
		transition: color var(--dur-fast);
	}
	.ns-row:hover .ns-icon {
		color: var(--text-default);
	}
	.ns-text {
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
		min-width: 0;
		flex: 1;
	}
	.ns-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		letter-spacing: var(--track-body);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ns-hint {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ns-row :global(.ns-chevron) {
		color: var(--text-faint);
		flex-shrink: 0;
		transition:
			transform var(--dur-fast),
			color var(--dur-fast);
	}
	.ns-row:hover :global(.ns-chevron) {
		color: var(--text-muted);
		transform: translateX(2px);
	}
	.ns-hide {
		position: absolute;
		right: 0.375rem;
		top: 50%;
		transform: translateY(-50%);
		display: inline-flex;
		align-items: center;
		color: var(--text-faint);
		background: var(--bg-raised);
		border: none;
		cursor: pointer;
		padding: 0.25rem;
		border-radius: var(--radius-sm);
		opacity: 0;
		transition: opacity var(--dur-fast);
	}
	.ns-item:hover .ns-hide,
	.ns-hide:focus-visible {
		opacity: 1;
	}
	.ns-hide:hover {
		color: var(--text-default);
		background-color: var(--fill-soft);
	}
</style>
