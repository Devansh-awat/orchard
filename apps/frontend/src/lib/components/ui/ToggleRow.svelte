<script lang="ts">
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
</script>

<label class="toggle-row" class:toggle-row--disabled={disabled}>
	<span class="toggle-info">
		<span class="toggle-label">{label}</span>
		{#if hint}
			<span class="toggle-hint">{hint}</span>
		{/if}
	</span>
	<span class="toggle-switch">
		<input type="checkbox" bind:checked {disabled} {onchange} />
		<span class="toggle-track"></span>
	</span>
</label>

<style>
	.toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		cursor: pointer;
	}

	.toggle-row--disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.toggle-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.toggle-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.toggle-hint {
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.toggle-switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
	}

	.toggle-switch input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}

	.toggle-track {
		width: 2.25rem;
		height: 1.25rem;
		border-radius: var(--radius-pill);
		background-color: var(--border-default);
		transition: background-color var(--dur-fast) ease;
		position: relative;
	}

	.toggle-track::after {
		content: '';
		position: absolute;
		top: 2.5px;
		left: 2.5px;
		width: 0.9375rem;
		height: 0.9375rem;
		border-radius: 50%;
		background: white;
		box-shadow: var(--elev-1);
		transition: transform var(--dur-fast) ease;
	}

	.toggle-switch input:checked + .toggle-track {
		background-color: var(--status-success);
	}

	.toggle-switch input:checked + .toggle-track::after {
		transform: translateX(1rem);
	}

	.toggle-switch input:focus-visible + .toggle-track {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
