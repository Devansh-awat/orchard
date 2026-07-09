<script lang="ts">
	import { Check, ChevronDown } from 'lucide-svelte';
	import PopoverPanel from './PopoverPanel.svelte';
	import { springRotate } from '$lib/utils/motion.svelte';

	export interface DropdownOption {
		value: string;
		label: string;
		description?: string;
		mono?: boolean;
	}

	let {
		value = $bindable(''),
		options,
		placeholder = 'Select…',
		id = undefined,
		disabled = false,
		placement = 'bottom-start',
		class: className = '',
		onchange = undefined
	}: {
		value?: string;
		options: DropdownOption[];
		placeholder?: string;
		id?: string;
		disabled?: boolean;
		placement?: 'bottom-start' | 'bottom-end';
		class?: string;
		onchange?: (value: string) => void;
	} = $props();

	let open = $state(false);
	const selected = $derived(options.find((o) => o.value === value) ?? null);

	function pick(option: DropdownOption, close: () => void) {
		value = option.value;
		onchange?.(option.value);
		close();
	}
</script>

<PopoverPanel bind:open {placement} sameWidth>
	{#snippet trigger(props, isOpen)}
		<button
			type="button"
			{id}
			{disabled}
			class="ui-dropdown-trigger{className ? ` ${className}` : ''}"
			class:ui-dropdown-trigger--open={isOpen}
			{...props}
		>
			<span class="ui-dropdown-value" class:ui-dropdown-value--placeholder={!selected}>
				{#if selected}
					{#if selected.mono}<code class="ui-dropdown-mono">{selected.label}</code
						>{:else}{selected.label}{/if}
				{:else}
					{placeholder}
				{/if}
			</span>
			<span
				class="ui-dropdown-chevron"
				{@attach springRotate(() => isOpen, { rest: 0, on: 180, stiffness: 380, damping: 22 })}
			>
				<ChevronDown size={14} />
			</span>
		</button>
	{/snippet}
	{#snippet children({ close })}
		<div
			class="ui-dropdown-list"
			role="listbox"
			aria-activedescendant={selected ? `${id}-${selected.value}` : undefined}
		>
			{#each options as option (option.value)}
				<button
					type="button"
					id="{id}-{option.value}"
					role="option"
					aria-selected={option.value === value}
					class="ui-dropdown-option"
					class:ui-dropdown-option--selected={option.value === value}
					onclick={() => pick(option, close)}
				>
					<span class="ui-dropdown-option-main">
						{#if option.mono}<code class="ui-dropdown-mono">{option.label}</code
							>{:else}{option.label}{/if}
						{#if option.description}
							<span class="ui-dropdown-option-desc">{option.description}</span>
						{/if}
					</span>
					{#if option.value === value}
						<Check size={14} class="ui-dropdown-check" />
					{/if}
				</button>
			{/each}
		</div>
	{/snippet}
</PopoverPanel>
