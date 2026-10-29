<script lang="ts">
	import Badge from '$lib/components/ui/Badge.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import SeverityMeter from '$lib/components/ui/SeverityMeter.svelte';
	import SeverityBar from '$lib/components/ui/SeverityBar.svelte';
	import CapacityList from '$lib/components/ui/CapacityList.svelte';
	import { SEVERITIES } from '$lib/components/ui/severity';
	import { statusMeta, type StatusKind } from '$lib/components/ui/status';

	let running = $state(true);
	let result = $state<StatusKind>('success');
	const STEPS = ['clone', 'build', 'push', 'deploy'];
	let phase = $state(0);
	function cycle(next: StatusKind) {
		result = next;
		running = true;
		phase = 0;
		for (let i = 1; i <= 4; i++) setTimeout(() => (phase = i), i * 900);
		setTimeout(() => (running = false), 4600);
	}

	const KINDS: StatusKind[] = ['success', 'progress', 'warning', 'error', 'info', 'neutral'];
	const LABELS: Record<StatusKind, string> = {
		success: 'Ready',
		progress: 'Building',
		warning: 'Unhealthy',
		error: 'Crashing',
		info: 'Queued',
		neutral: 'Stopped'
	};
</script>

<SectionCard
	title="Status"
	description="Quiet when healthy. Live dot only while something is in flight."
>
	<div class="flex flex-col gap-3">
		<div class="dots" data-testid="dot-language">
			{#each KINDS as k (k)}
				<span class="dot-cell"
					><StatusDot meta={statusMeta(k, LABELS[k])} size={10} /><small>{LABELS[k]}</small></span
				>
			{/each}
			<span class="dot-cell"
				><StatusDot meta={statusMeta('progress', 'Building', true)} size={10} /><small
					>Building</small
				></span
			>
			<span class="dot-cell"
				><StatusDot
					meta={statusMeta('progress', 'Deploying', true)}
					tone="deploy"
					size={10}
				/><small>Deploying</small></span
			>
			<span class="dot-cell"
				><StatusDot
					meta={statusMeta('progress', 'Building')}
					steps={['done', 'done', 'active', 'pending', 'pending']}
					size={10}
				/><small>Step 3 of 5</small></span
			>
			<span class="dot-cell"
				><StatusDot
					meta={statusMeta('progress', 'Deploying')}
					tone="deploy"
					steps={['done', 'failed', 'active', 'pending']}
					size={10}
				/><small>1 pod failed</small></span
			>
			<span class="dot-cell"
				><StatusDot
					meta={statusMeta(running ? 'progress' : result, 'Run', running)}
					size={10}
				/><small>{running ? 'Running' : result}</small></span
			>
			<Button size="sm" variant="secondary" onclick={() => cycle('success')}>Finish ok</Button>
			<Button size="sm" variant="secondary" onclick={() => cycle('error')}>Finish failed</Button>
		</div>
		<div class="flex flex-wrap gap-2">
			{#each KINDS as k (k)}<StatusBadge meta={statusMeta(k, LABELS[k], k === 'progress')} />{/each}
		</div>
		<div class="flex flex-wrap gap-2">
			{#each KINDS as k (k)}<StatusBadge variant="solid" meta={statusMeta(k, LABELS[k])} />{/each}
		</div>
		<div class="flex flex-wrap gap-4">
			{#each KINDS as k (k)}<StatusBadge
					variant="plain"
					meta={statusMeta(k, LABELS[k], k === 'progress')}
				/>{/each}
		</div>
		<div class="flex flex-wrap gap-2">
			<Badge>Hobby</Badge>
			<Badge tone="accent">New</Badge>
			<Badge tone="success">+12%</Badge>
			<Badge tone="warning">Expiring</Badge>
			<Badge tone="error">3 errors</Badge>
			<Badge tone="info">Beta</Badge>
		</div>
		<div class="flex flex-wrap gap-4" data-testid="severity">
			{#each SEVERITIES as sev (sev)}<SeverityMeter severity={sev} label />{/each}
		</div>
		<div class="severity-demo">
			<SeverityBar counts={{ critical: 3, high: 6, medium: 4, low: 3 }} />
			<SeverityBar counts={{}} />
		</div>
		<div class="severity-demo" data-testid="capacity">
			<CapacityList
				label="Volumes"
				format={(v) => `${v} GB`}
				items={[
					{ id: 'data', label: 'data', detail: '/var/lib/data', value: 4, max: 10 },
					{ id: 'cache', label: 'cache', detail: '/cache', value: 8.5, max: 10 },
					{ id: 'uploads', label: 'uploads', detail: '/uploads', value: 9.6, max: 10 },
					{ id: 'tmp', label: 'tmp', detail: '/tmp', value: null, max: 5 }
				]}
			/>
		</div>
	</div>
</SectionCard>

<style>
	.dots {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1.25rem;
		padding: 0.75rem 0 0.25rem;
	}
	.severity-demo {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 22rem));
		gap: 2rem;
		padding-top: 0.5rem;
	}
	.dot-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.625rem;
		font-size: var(--text-footnote);
		color: var(--text-muted);
	}
</style>
