<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Check, ChevronsUpDown } from 'lucide-svelte';
	import PopoverPanel from './PopoverPanel.svelte';
	import type { DropdownOption } from './dropdown';

	let {
		value = $bindable(''),
		options,
		placeholder = 'Select…',
		id = undefined,
		disabled = false,
		placement = 'bottom-start',
		class: className = '',
		onchange = undefined,
		icon = undefined,
		ariaLabelledby = undefined
	}: {
		value?: string;
		options: DropdownOption[];
		placeholder?: string;
		id?: string;
		disabled?: boolean;
		placement?: 'bottom-start' | 'bottom-end';
		class?: string;
		onchange?: (value: string) => void;
		icon?: Snippet<[string]>;
		ariaLabelledby?: string;
	} = $props();

	const uid = $props.id();
	const base = $derived(id ?? uid);

	let open = $state(false);
	let active = $state(-1);
	let wasOpen = false;

	const selectedIndex = $derived(options.findIndex((o) => o.value === value));
	const selected = $derived(selectedIndex >= 0 ? options[selectedIndex] : null);

	function firstEnabled(from: number, step: 1 | -1) {
		const n = options.length;
		for (let k = 0; k < n; k++) {
			const i = (((from + step * k) % n) + n) % n;
			if (!options[i].disabled) return i;
		}
		return -1;
	}

	$effect(() => {
		if (open && !wasOpen) {
			active = selectedIndex >= 0 ? selectedIndex : firstEnabled(0, 1);
			requestAnimationFrame(reveal);
		}
		wasOpen = open;
	});

	function optionId(i: number) {
		return `${base}-opt-${i}`;
	}

	function reveal() {
		if (active >= 0)
			document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
	}

	function pick(option: DropdownOption) {
		if (option.disabled) return;
		value = option.value;
		onchange?.(option.value);
		open = false;
	}

	function onTriggerKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			open = true;
		}
	}

	function onListKeydown(e: KeyboardEvent) {
		let next = -1;
		if (e.key === 'ArrowDown') next = firstEnabled(active + 1, 1);
		else if (e.key === 'ArrowUp')
			next = firstEnabled(active < 0 ? options.length - 1 : active - 1, -1);
		else if (e.key === 'Home') next = firstEnabled(0, 1);
		else if (e.key === 'End') next = firstEnabled(options.length - 1, -1);
		else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			if (active >= 0) pick(options[active]);
			return;
		} else if (e.key.length === 1 && /\S/.test(e.key)) {
			const key = e.key.toLowerCase();
			const n = options.length;
			for (let k = 1; k <= n; k++) {
				const i = (active + k) % n;
				if (!options[i].disabled && options[i].label.toLowerCase().startsWith(key)) {
					next = i;
					break;
				}
			}
		}
		if (next < 0) return;
		e.preventDefault();
		active = next;
		reveal();
	}
</script>

{#snippet glyph(option: DropdownOption)}
	{#if icon}
		<span class="ui-dropdown-icon">{@render icon(option.value)}</span>
	{:else if option.icon}
		{@const Glyph = option.icon}
		<span class="ui-dropdown-icon"><Glyph size={16} /></span>
	{/if}
{/snippet}

{#snippet text(option: DropdownOption)}
	{#if option.mono}<code class="ui-dropdown-mono">{option.label}</code>{:else}{option.label}{/if}
{/snippet}

<PopoverPanel
	bind:open
	{placement}
	sameWidth
	class="ui-popover--menu"
	role="listbox"
	aria-labelledby={ariaLabelledby}
	aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
	onkeydown={onListKeydown}
>
	{#snippet trigger(props, isOpen)}
		<button
			type="button"
			id={base}
			{disabled}
			aria-labelledby={ariaLabelledby}
			aria-haspopup="listbox"
			aria-expanded={isOpen}
			class="ui-dropdown-trigger{className ? ` ${className}` : ''}"
			class:ui-dropdown-trigger--open={isOpen}
			{...props}
			onkeydown={onTriggerKeydown}
		>
			<span class="ui-dropdown-value" class:ui-dropdown-value--placeholder={!selected}>
				{#if selected}
					{@render glyph(selected)}
					<span class="ui-dropdown-text">{@render text(selected)}</span>
				{:else}
					<span class="ui-dropdown-text">{placeholder}</span>
				{/if}
			</span>
			<span class="ui-dropdown-chevron" aria-hidden="true"><ChevronsUpDown size={14} /></span>
		</button>
	{/snippet}
	{#snippet children()}
		<div class="ui-dropdown-list" role="presentation">
			{#each options as option, i (option.value)}
				<button
					type="button"
					id={optionId(i)}
					role="option"
					tabindex="-1"
					aria-selected={option.value === value}
					aria-disabled={option.disabled || undefined}
					disabled={option.disabled}
					class="ui-dropdown-option"
					class:ui-dropdown-option--rich={!!option.description}
					class:ui-dropdown-option--selected={option.value === value}
					data-highlighted={i === active || undefined}
					onpointermove={() => {
						if (!option.disabled) active = i;
					}}
					onclick={() => pick(option)}
				>
					{@render glyph(option)}
					<span class="ui-dropdown-option-main">
						<span class="ui-dropdown-text">{@render text(option)}</span>
						{#if option.description}
							<span class="ui-dropdown-option-desc">{option.description}</span>
						{/if}
					</span>
					<span class="ui-dropdown-check" aria-hidden="true">
						{#if option.value === value}<Check size={16} strokeWidth={2.25} />{/if}
					</span>
				</button>
			{/each}
		</div>
	{/snippet}
</PopoverPanel>
