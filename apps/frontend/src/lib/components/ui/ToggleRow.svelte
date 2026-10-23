<script lang="ts">
	import Switch from './Switch.svelte';

	let {
		checked = $bindable(false),
		label,
		hint = null,
		disabled = false,
		onchange = undefined
	}: {
		checked?: boolean;
		label: string;
		hint?: string | null;
		disabled?: boolean;
		onchange?: (() => void) | undefined;
	} = $props();

	const id = $props.id();
</script>

<div class="row" class:row--disabled={disabled}>
	<label class="info" for={id}>
		<span class="label">{label}</span>
		{#if hint}<span class="hint">{hint}</span>{/if}
	</label>
	<Switch {id} bind:checked {disabled} onchange={() => onchange?.()} />
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.row--disabled {
		opacity: 0.6;
	}
	.info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		cursor: pointer;
	}
	.label {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.hint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
