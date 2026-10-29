<script lang="ts">
	import { severityMeta } from './severity';

	let {
		severity,
		label = false,
		quiet = false
	}: {
		severity: string | null | undefined;
		label?: boolean;
		quiet?: boolean;
	} = $props();

	const meta = $derived(severityMeta(severity));
</script>

<span
	class="severity severity--{meta.tone}"
	class:severity--top={meta.level === 4 && !quiet}
	class:severity--quiet={quiet}
	role={label ? undefined : 'img'}
	aria-label={label ? undefined : `${meta.label} severity`}
>
	<span class="bars" aria-hidden="true">
		{#each [1, 2, 3, 4] as step (step)}
			<span class="bar" class:bar--on={step <= meta.level}></span>
		{/each}
	</span>
	{#if label}<span class="label">{meta.label}</span>{/if}
</span>

<style>
	.severity {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.bars {
		display: inline-flex;
		align-items: flex-end;
		gap: 0.125rem;
		height: 0.625rem;
		flex-shrink: 0;
	}
	.bar {
		width: 0.1875rem;
		border-radius: 0.0625rem;
		background: var(--border-strong);
	}
	.bar:nth-child(1) {
		height: 40%;
	}
	.bar:nth-child(2) {
		height: 60%;
	}
	.bar:nth-child(3) {
		height: 80%;
	}
	.bar:nth-child(4) {
		height: 100%;
	}
	.severity--error .bar--on {
		background: var(--status-error-solid);
	}
	.severity--warning .bar--on {
		background: var(--status-warning-solid);
	}
	.severity--neutral .bar--on {
		background: var(--status-neutral-solid);
	}
	.label {
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
	}
	.severity--error .label {
		color: var(--status-error);
	}
	.severity--quiet .bar--on {
		background: var(--border-strong);
	}
	.severity--quiet .label {
		color: var(--text-faint);
	}
	.severity--top .label {
		font-weight: var(--weight-medium);
	}
</style>
