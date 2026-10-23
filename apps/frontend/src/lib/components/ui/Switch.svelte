<script lang="ts">
	let {
		checked = $bindable(false),
		disabled = false,
		label = undefined,
		id = undefined,
		onchange = undefined
	}: {
		checked?: boolean;
		disabled?: boolean;
		label?: string;
		id?: string;
		onchange?: (checked: boolean) => void;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	{id}
	class="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	onclick={() => {
		checked = !checked;
		onchange?.(checked);
	}}
>
	<span class="thumb"></span>
</button>

<style>
	.switch {
		position: relative;
		flex-shrink: 0;
		width: 2.25rem;
		height: 1.375rem;
		padding: 0;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--neutral-5);
		cursor: pointer;
		transition: background-color var(--dur-base) ease;
	}
	.switch[aria-checked='true'] {
		background: var(--green-7);
	}
	.switch:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.thumb {
		position: absolute;
		top: 0.125rem;
		left: 0.125rem;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 50%;
		background: white;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.2),
			0 2px 6px rgb(0 0 0 / 0.1);
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.switch[aria-checked='true'] .thumb {
		transform: translateX(0.875rem);
	}
	.switch:active:not(:disabled) .thumb {
		transform: scaleX(1.15);
		transform-origin: left center;
	}
	.switch[aria-checked='true']:active:not(:disabled) .thumb {
		transform: translateX(0.875rem) scaleX(1.15);
		transform-origin: right center;
	}
</style>
