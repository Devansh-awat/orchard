<script lang="ts">
	import { Combobox } from 'melt/builders';
	import { Check, ChevronsUpDown, Search } from 'lucide-svelte';
	import type { DropdownOption } from './dropdown';
	import { overlayMotion } from '$lib/utils/motion.svelte';

	let {
		value = $bindable(''),
		options,
		placeholder = 'Search',
		label = undefined,
		ariaLabelledby = undefined,
		disabled = false,
		empty = 'No matches',
		class: className = '',
		onchange = undefined
	}: {
		value?: string;
		options: DropdownOption[];
		placeholder?: string;
		label?: string;
		ariaLabelledby?: string;
		disabled?: boolean;
		empty?: string;
		class?: string;
		onchange?: (value: string) => void;
	} = $props();

	const combo = new Combobox<string>({
		value: () => value || undefined,
		onValueChange: (next) => {
			value = next ?? '';
			onchange?.(value);
		},
		floatingConfig: {
			computePosition: { placement: 'bottom-start' },
			offset: { mainAxis: 6 }
		}
	});

	const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? '');

	$effect(() => {
		const text = selectedLabel;
		if (!combo.open) combo.inputValue = text;
	});

	const query = $derived(combo.touched ? combo.inputValue.trim().toLowerCase() : '');
	const filtered = $derived(
		query
			? options.filter(
					(o) =>
						o.label.toLowerCase().includes(query) ||
						o.value.toLowerCase().includes(query) ||
						o.description?.toLowerCase().includes(query)
				)
			: options
	);
</script>

<div class="field {className}" class:field--open={combo.open} class:field--disabled={disabled}>
	<span class="lead" aria-hidden="true"><Search size={14} /></span>
	<input
		{...combo.input}
		class="control"
		{placeholder}
		{disabled}
		aria-label={label}
		aria-labelledby={ariaLabelledby}
		autocomplete="off"
		spellcheck={false}
	/>
	<button
		{...combo.trigger}
		type="button"
		class="chevron"
		tabindex="-1"
		aria-label="Show options"
		{disabled}
	>
		<ChevronsUpDown size={14} />
	</button>
</div>

<div
	{...combo.content}
	class="ui-popover ui-popover--menu"
	{@attach overlayMotion(() => combo.open, { origin: 'center top' })}
>
	{#each filtered as option (option.value)}
		<div
			{...combo.getOption(option.value, option.label)}
			class="ui-dropdown-option"
			class:ui-dropdown-option--rich={!!option.description}
			class:ui-dropdown-option--selected={combo.isSelected(option.value)}
		>
			{#if option.icon}
				{@const Glyph = option.icon}
				<span class="ui-dropdown-icon"><Glyph size={16} /></span>
			{/if}
			<span class="ui-dropdown-option-main">
				<span class="ui-dropdown-text">
					{#if option.mono}<code class="ui-dropdown-mono">{option.label}</code
						>{:else}{option.label}{/if}
				</span>
				{#if option.description}
					<span class="ui-dropdown-option-desc">{option.description}</span>
				{/if}
			</span>
			<span class="ui-dropdown-check" aria-hidden="true">
				{#if combo.isSelected(option.value)}<Check size={16} strokeWidth={2.25} />{/if}
			</span>
		</div>
	{:else}
		<div class="ui-dropdown-empty" role="presentation">
			<span class="empty-text"
				>{empty}{#if query}&nbsp;for “{combo.inputValue.trim()}”{/if}</span
			>
		</div>
	{/each}
</div>

<style>
	.field {
		position: relative;
		display: block;
		min-width: 0;
	}
	.lead {
		position: absolute;
		top: 50%;
		left: 0.625rem;
		display: flex;
		color: var(--text-faint);
		transform: translateY(-50%);
		pointer-events: none;
	}
	.control {
		display: block;
		width: 100%;
		min-width: 0;
		height: 2rem;
		padding: 0 2rem 0 2rem;
		border: none;
		border-radius: var(--radius-control);
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: inset 0 0 0 1px var(--border-default);
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		transition:
			box-shadow var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}
	.control::placeholder {
		color: var(--text-faint);
	}
	.control:hover:not(:disabled) {
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}
	.control:focus {
		outline: none;
		box-shadow:
			inset 0 0 0 1px var(--accent),
			0 0 0 3px var(--focus-ring);
	}
	.chevron {
		position: absolute;
		top: 0.25rem;
		right: 0.25rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		border-radius: calc(var(--radius-control) - 0.25rem);
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.chevron:hover:not(:disabled),
	.field--open .chevron {
		background: color-mix(in oklab, var(--neutral-10) 7%, transparent);
		color: var(--text-default);
	}
	.field--disabled {
		opacity: 0.5;
	}
	.field--disabled .control,
	.field--disabled .chevron {
		cursor: not-allowed;
	}
	.empty-text {
		display: block;
		text-box: trim-both cap alphabetic;
	}
</style>
