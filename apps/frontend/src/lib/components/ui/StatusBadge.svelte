<script lang="ts">
	import type { StatusMeta } from './status';
	import StatusDot, { type DotStep } from './StatusDot.svelte';

	let {
		meta,
		variant = 'subtle',
		tone = undefined,
		steps = undefined
	}: {
		meta: StatusMeta;
		variant?: 'subtle' | 'plain' | 'solid';
		tone?: 'deploy';
		steps?: DotStep[];
	} = $props();
</script>

<span
	class="sb sb--{variant} sb--{tone ?? meta.kind}"
	title={meta.label.length > 32 ? meta.label : undefined}
>
	{#if variant !== 'solid'}<StatusDot {meta} {tone} {steps} size={8} />{/if}
	<span class="sb-label">{meta.label}</span>
</span>

<style>
	.sb {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		max-width: 100%;
		height: 1.375rem;
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		line-height: 1;
		white-space: nowrap;
	}
	.sb-label {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
	}
	.sb--subtle,
	.sb--solid {
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
	}
	.sb--plain {
		height: auto;
		color: var(--text-default);
	}

	.sb--subtle.sb--success {
		background: var(--green-2);
		color: var(--green-9);
	}
	.sb--subtle.sb--warning,
	.sb--subtle.sb--progress {
		background: var(--amber-2);
		color: var(--amber-9);
	}
	.sb--subtle.sb--error {
		background: var(--red-2);
		color: var(--red-9);
	}
	.sb--subtle.sb--deploy {
		background: var(--status-deploy-bg);
		color: var(--status-deploy);
	}
	.sb--subtle.sb--info {
		background: var(--blue-2);
		color: var(--blue-9);
	}
	.sb--subtle.sb--neutral {
		background: var(--bg-active);
		color: var(--text-muted);
	}

	.sb--solid.sb--success {
		background: var(--green-7);
		color: var(--green-contrast);
	}
	.sb--solid.sb--warning,
	.sb--solid.sb--progress {
		background: var(--amber-7);
		color: var(--amber-contrast);
	}
	.sb--solid.sb--error {
		background: var(--red-7);
		color: var(--red-contrast);
	}
	.sb--solid.sb--info {
		background: var(--blue-7);
		color: var(--blue-contrast);
	}
	.sb--solid.sb--neutral {
		background: var(--neutral-7);
		color: var(--neutral-app);
	}
</style>
