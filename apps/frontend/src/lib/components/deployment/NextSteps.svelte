<script lang="ts">
	import { X, ArrowRight } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { apiFetch } from '$lib/stores';
	import { dismissedSteps, dismissStep, dismissAllSteps } from '$lib/stores/checklist';
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
		{ title: string; body: string; cta: string; tab?: string; settings?: string }
	> = {
		'auto-deploy': {
			title: 'Deploy on every push',
			body: 'Orchard can build and roll out whenever you push to your branch, so you never come back here to click rebuild.',
			cta: 'Turn it on',
			settings: 'source'
		},
		domain: {
			title: 'Put it on your own domain',
			body: 'Right now this only answers on the URL Orchard generated. Point a domain at it and the certificate is handled for you.',
			cta: 'Add a domain',
			tab: 'network'
		},
		resources: {
			title: 'Give it the right amount of memory',
			body: 'This app is running on the organization default. Set CPU and memory deliberately so it neither gets throttled nor holds space it never uses.',
			cta: 'Set resources',
			settings: 'resources'
		},
		notifications: {
			title: 'Find out when it breaks',
			body: 'Nothing will tell you if this app starts crashing at 3am. Send failures to Slack, Discord, a webhook, or your inbox.',
			cta: 'Set up alerts',
			settings: 'notifications'
		},
		'health-check': {
			title: 'Let Orchard know when it is really up',
			body: 'Without a health check a container that started but cannot serve still counts as ready, and a bad deploy rolls out anyway.',
			cta: 'Add a check',
			settings: 'health'
		},
		'pull-policy': {
			title: 'This image tag can move',
			body: 'Restarting reuses the image already cached on the node, so pushing over this tag will not show up. Switch to re-pull on every start.',
			cta: 'Change pull policy',
			settings: 'resources'
		},
		cli: {
			title: 'Do all of this from the terminal',
			body: 'Deploy the directory you are standing in, tail logs, and scale without opening a browser.',
			cta: 'Show me'
		}
	};

	let steps = $state<Step[]>([]);
	let dismissed = $state<string[]>([]);
	let cliOpen = $state(false);
	// Plain let, not $state: this only guards the fetch effect from re-running,
	// and reading a $state inside the effect that sets it would loop.
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
			/* the card is a nudge, not a feature: silence is the right failure */
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
		// 'cli' is a per-user dismissal, so it has to go through the global path
		// too or it comes back on the next app.
		if (ids.includes('cli')) dismissStep(deploymentId, 'cli', true);
		dismissed = [...dismissed, ...ids];
	}
</script>

{#if visible.length > 0}
	<div class="ns-card" {@attach motionStagger({ index: 0, from: { y: -6, opacity: 0 } })}>
		<div class="ns-head">
			<span class="ns-title">Worth doing next</span>
			<button class="ns-dismiss-all" type="button" onclick={hideAll}>Dismiss all</button>
		</div>
		<ul class="ns-list">
			{#each visible as step, i (step.id)}
				{@const copy = COPY[step.id]}
				<li class="ns-item" {@attach motionStagger({ index: i, from: { y: 4, opacity: 0 } })}>
					<div class="ns-item-body">
						<span class="ns-item-title">{copy.title}</span>
						<span class="ns-item-desc">{copy.body}</span>
					</div>
					<div class="ns-item-actions">
						<button class="ns-cta" type="button" onclick={() => act(step)}>
							{copy.cta}
							<ArrowRight class="h-3 w-3" />
						</button>
						<button
							class="ns-hide"
							type="button"
							onclick={() => hide(step.id)}
							aria-label={`Dismiss: ${copy.title}`}
						>
							<X class="h-3 w-3" />
						</button>
					</div>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<CliModal bind:open={cliOpen} />

<style>
	.ns-card {
		border: 1px solid var(--border-edge);
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		padding: 0.75rem 0.875rem;
		margin-bottom: 1rem;
	}
	.ns-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}
	.ns-title {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-fg);
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
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0;
		border-top: 1px solid var(--border-subtle);
	}
	.ns-item:first-child {
		border-top: none;
	}
	.ns-item-body {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.ns-item-title {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-fg);
	}
	.ns-item-desc {
		font-size: var(--text-micro);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.ns-item-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}
	.ns-cta {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		white-space: nowrap;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--accent);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.25rem 0.375rem;
		border-radius: var(--radius-sm);
	}
	.ns-cta:hover {
		background-color: var(--fill-soft);
	}
	.ns-hide {
		display: inline-flex;
		align-items: center;
		color: var(--text-faint);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.25rem;
		border-radius: var(--radius-sm);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.ns-item:hover .ns-hide,
	.ns-hide:focus-visible {
		opacity: 1;
	}
	.ns-hide:hover {
		color: var(--text-fg);
		background-color: var(--fill-soft);
	}
</style>
