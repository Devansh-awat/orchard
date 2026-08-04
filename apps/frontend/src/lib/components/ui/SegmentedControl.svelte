<script lang="ts">
	interface Option {
		value: string;
		label: string;
		hint?: string;
		optionClass?: string;
	}

	let {
		options,
		value = $bindable(''),
		label,
		onchange = undefined,
		grow = false
	}: {
		options: readonly Option[];
		value: string;
		label: string;
		onchange?: (value: string) => void;
		grow?: boolean;
	} = $props();

	function select(next: string) {
		value = next;
		onchange?.(next);
	}
</script>

<div class="ui-seg" class:ui-seg--grow={grow} role="radiogroup" aria-label={label}>
	{#each options as opt (opt.value)}
		<button
			type="button"
			role="radio"
			aria-checked={value === opt.value}
			aria-label={opt.hint}
			class="ui-seg-btn {opt.optionClass ?? ''}"
			class:ui-seg-btn--active={value === opt.value}
			onclick={() => select(opt.value)}
		>
			{opt.label}
		</button>
	{/each}
</div>

<style>
	.ui-seg {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.25rem;
		border-radius: var(--radius-md);
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		flex-shrink: 0;
	}
	.ui-seg--grow {
		display: flex;
		width: 100%;
	}
	.ui-seg--grow .ui-seg-btn {
		flex: 1;
	}
	.ui-seg-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 2rem;
		border: none;
		background: none;
		padding: 0.3125rem var(--space-3);
		border-radius: var(--radius-xs);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}
	.ui-seg-btn:hover {
		color: var(--text-default);
	}
	.ui-seg-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.ui-seg-btn--active {
		background-color: var(--bg-surface);
		color: var(--text-default);
		box-shadow: var(--elev-1);
	}
</style>
