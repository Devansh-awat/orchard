<script lang="ts">
	let {
		checked = $bindable(false),
		indeterminate = $bindable(false),
		disabled = false,
		label = undefined,
		hint = undefined,
		id = undefined,
		name = undefined,
		value = undefined,
		onchange = undefined
	}: {
		checked?: boolean;
		indeterminate?: boolean;
		disabled?: boolean;
		label?: string;
		hint?: string;
		id?: string;
		name?: string;
		value?: string;
		onchange?: (checked: boolean) => void;
	} = $props();

	const uid = $props.id();
	const inputId = $derived(id ?? `cb-${uid}`);
	const hintId = $derived(hint ? `${inputId}-hint` : undefined);
</script>

<label class="choice" class:choice--disabled={disabled} class:choice--bare={!label} for={inputId}>
	<span class="control">
		<input
			id={inputId}
			type="checkbox"
			class="native"
			{name}
			{value}
			{disabled}
			aria-label={label ? undefined : 'Select'}
			aria-describedby={hintId}
			bind:checked
			bind:indeterminate
			onchange={() => onchange?.(checked)}
		/>
		<svg class="glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path class="tick" d="M4.25 8.4 6.85 10.9 11.75 5.35" />
			<path class="dash" d="M4.75 8h6.5" />
		</svg>
	</span>
	{#if label}<span class="label">{label}</span>{/if}
	{#if hint}<span class="hint" id={hintId}>{hint}</span>{/if}
</label>

<style>
	.choice {
		display: inline-grid;
		grid-template-columns: 1rem minmax(0, 1fr);
		align-items: center;
		column-gap: 0.5rem;
		row-gap: 0.3125rem;
		min-width: 0;
		cursor: pointer;
		user-select: none;
	}
	.choice--bare {
		display: inline-flex;
	}
	.choice--disabled {
		cursor: not-allowed;
	}
	.control {
		position: relative;
		display: grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		transition: transform var(--spring-interactive-duration) var(--spring-interactive);
	}
	.choice:active:not(.choice--disabled) .control {
		transform: scale(0.9);
	}
	.native {
		grid-area: 1 / 1;
		width: 1rem;
		height: 1rem;
		margin: 0;
		border-radius: 0.3125rem;
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow:
			inset 0 0 0 1px var(--border-strong),
			0 1px 1px color-mix(in oklab, var(--neutral-10) 4%, transparent);
		appearance: none;
		cursor: inherit;
		transition:
			background-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}
	.choice:hover:not(.choice--disabled) .native:not(:checked, :indeterminate) {
		box-shadow:
			inset 0 0 0 1px var(--neutral-6),
			0 1px 1px color-mix(in oklab, var(--neutral-10) 4%, transparent);
	}
	.native:checked,
	.native:indeterminate {
		background: var(--accent);
		box-shadow:
			inset 0 0 0 0.5px color-mix(in oklab, var(--accent-10) 30%, transparent),
			inset 0 1px 0 color-mix(in oklab, var(--accent-contrast) 18%, transparent),
			0 1px 2px color-mix(in oklab, var(--accent-10) 24%, transparent);
	}
	.choice:hover:not(.choice--disabled) .native:checked,
	.choice:hover:not(.choice--disabled) .native:indeterminate {
		background: var(--accent-hover);
	}
	.native:focus-visible {
		outline: none;
		box-shadow:
			inset 0 0 0 1px var(--accent),
			0 0 0 3px var(--focus-ring);
	}
	.native:checked:focus-visible,
	.native:indeterminate:focus-visible {
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.native:disabled {
		opacity: 0.4;
	}
	.glyph {
		grid-area: 1 / 1;
		width: 1rem;
		height: 1rem;
		color: var(--text-on-accent);
		pointer-events: none;
	}
	.tick,
	.dash {
		stroke: currentColor;
		stroke-width: 1.75;
		stroke-linecap: round;
		stroke-linejoin: round;
		transform-origin: 8px 8px;
		opacity: 0;
		transform: scale(0.4);
		transition:
			opacity 120ms ease,
			transform var(--spring-bouncy-duration) var(--spring-bouncy);
	}
	.native:checked:not(:indeterminate) + .glyph .tick,
	.native:indeterminate + .glyph .dash {
		opacity: 1;
		transform: none;
	}
	.native:disabled + .glyph {
		opacity: 0.6;
	}
	.label {
		display: block;
		min-width: 0;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-regular);
		color: var(--text-default);
		text-box: trim-both cap alphabetic;
	}
	.hint {
		grid-column: 2;
		display: block;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		text-box: trim-both cap alphabetic;
	}
	.choice--disabled .label {
		color: var(--text-faint);
	}
	.choice--disabled .hint {
		color: var(--text-faint);
	}
</style>
