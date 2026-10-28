<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Check, Search, Plus } from 'lucide-svelte';
	import PopoverPanel from './PopoverPanel.svelte';
	import SelectTrigger from './SelectTrigger.svelte';
	import Input from './Input.svelte';
	import Spinner from './Spinner.svelte';
	import type { DropdownOption } from './dropdown';

	let {
		value = $bindable(''),
		query = $bindable(''),
		open = $bindable(false),
		options,
		placeholder = 'Select',
		prefix = undefined,
		searchPlaceholder = 'Search',
		loading = false,
		filter = true,
		creatable = false,
		createLabel = (q: string) => `Use “${q}”`,
		oncreate = undefined,
		onchange = undefined,
		onclear = undefined,
		empty = 'Nothing found',
		size = 'md',
		disabled = false,
		mono = false,
		width = undefined,
		placement = 'bottom-start',
		block = false,
		leading = undefined,
		optionLeading = undefined,
		trailing = undefined,
		footer = undefined
	}: {
		value?: string;
		query?: string;
		open?: boolean;
		options: DropdownOption[];
		placeholder?: string;
		prefix?: string;
		searchPlaceholder?: string;
		loading?: boolean;
		filter?: boolean;
		creatable?: boolean;
		createLabel?: (q: string) => string;
		oncreate?: (q: string) => void;
		onchange?: (value: string) => void;
		onclear?: () => void;
		empty?: string | Snippet<[string]>;
		size?: 'sm' | 'md' | 'lg';
		disabled?: boolean;
		mono?: boolean;
		width?: string;
		placement?: 'bottom-start' | 'bottom-end';
		block?: boolean;
		leading?: Snippet;
		optionLeading?: Snippet<[DropdownOption]>;
		trailing?: Snippet<[DropdownOption]>;
		footer?: Snippet<[{ close: () => void }]>;
	} = $props();

	const uid = $props.id();
	const CREATE = '\u0000create';

	let active = $state(0);
	let search = $state<HTMLInputElement | null>(null);

	const typed = $derived(query.trim());
	const selected = $derived(options.find((o) => o.value === value) ?? null);
	const shown = $derived(selected?.label ?? (value || null));

	const filtered = $derived(
		filter && typed
			? options.filter(
					(o) =>
						o.label.toLowerCase().includes(typed.toLowerCase()) ||
						(o.description?.toLowerCase().includes(typed.toLowerCase()) ?? false)
				)
			: options
	);
	const showCreate = $derived(
		creatable && !!typed && !options.some((o) => o.value === typed || o.label === typed)
	);
	const rows = $derived<DropdownOption[]>([
		...(showCreate ? [{ value: CREATE, label: createLabel(typed) }] : []),
		...filtered
	]);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			const at = rows.findIndex((r) => r.value === value);
			active = at >= 0 ? at : 0;
			requestAnimationFrame(() => {
				search?.focus();
				reveal();
			});
		}
		if (!open && wasOpen) query = '';
		wasOpen = open;
	});

	$effect(() => {
		typed;
		active = 0;
	});

	const optionId = (i: number) => `${uid}-opt-${i}`;

	function reveal() {
		document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
	}

	function pick(row: DropdownOption) {
		if (row.disabled) return;
		if (row.value === CREATE) {
			value = typed;
			oncreate?.(typed);
			onchange?.(typed);
		} else {
			value = row.value;
			onchange?.(row.value);
		}
		open = false;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!rows.length) return;
			active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
			reveal();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const row = rows[active];
			if (row) pick(row);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			if (query) query = '';
			else open = false;
		}
	}
</script>

<PopoverPanel
	bind:open
	{placement}
	sameWidth={!width}
	class="ui-popover--menu ui-search-picker"
	style={width ? `width: ${width}` : undefined}
>
	{#snippet trigger(props, isOpen)}
		<SelectTrigger
			{...props}
			{prefix}
			{placeholder}
			{size}
			{disabled}
			{leading}
			{block}
			{mono}
			value={shown}
			open={isOpen}
			loading={loading && !isOpen}
			onclear={onclear && value ? onclear : undefined}
		/>
	{/snippet}
	{#snippet children({ close })}
		<div class="head">
			<Input
				bind:element={search}
				bind:value={query}
				icon={Search}
				size="sm"
				placeholder={searchPlaceholder}
				autocomplete="off"
				spellcheck="false"
				role="combobox"
				aria-controls="{uid}-list"
				aria-expanded="true"
				aria-activedescendant={rows[active] ? optionId(active) : undefined}
				{onkeydown}
			/>
		</div>
		<div class="list" class:list--unpicked={!selected} id="{uid}-list" role="listbox">
			{#if loading}
				<div class="ui-dropdown-empty"><Spinner size={14} /></div>
			{:else}
				{#each rows as row, i (row.value)}
					<button
						type="button"
						id={optionId(i)}
						role="option"
						tabindex="-1"
						aria-selected={row.value === value}
						disabled={row.disabled}
						class="ui-dropdown-option"
						class:ui-dropdown-option--rich={!!row.description}
						data-highlighted={i === active || undefined}
						onpointermove={() => (active = i)}
						onclick={() => pick(row)}
					>
						<span class="ui-dropdown-check" aria-hidden="true">
							{#if row.value === CREATE}<Plus size={16} />{:else if row.value === value}<Check
									size={16}
									strokeWidth={2.25}
								/>{/if}
						</span>
						{#if row.value !== CREATE && optionLeading}
							<span class="ui-dropdown-icon">{@render optionLeading(row)}</span>
						{:else if row.icon}
							{@const Glyph = row.icon}
							<span class="ui-dropdown-icon"><Glyph size={16} /></span>
						{/if}
						<span class="ui-dropdown-option-main">
							<span class="ui-dropdown-text" class:ui-dropdown-mono={mono || row.mono}
								>{row.label}</span
							>
							{#if row.description}<span class="ui-dropdown-option-desc">{row.description}</span
								>{/if}
						</span>
						{#if trailing && row.value !== CREATE}<span class="trail">{@render trailing(row)}</span
							>{/if}
					</button>
				{:else}
					<div class="ui-dropdown-empty">
						{#if typeof empty === 'string'}{empty}{#if typed}&nbsp;for “{typed}”{/if}{:else}{@render empty(
								typed
							)}{/if}
					</div>
				{/each}
			{/if}
		</div>
		{#if footer}
			<div class="foot">{@render footer({ close })}</div>
		{/if}
	{/snippet}
</PopoverPanel>

<style>
	:global(.ui-search-picker) {
		display: flex;
		flex-direction: column;
		min-width: max(18rem, var(--melt-invoker-width, 0px));
		max-height: min(24rem, max(14rem, var(--melt-popover-available-height, 24rem)));
		overflow: hidden;
	}
	.head {
		padding: 0.125rem 0.125rem var(--float-pad);
	}
	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}
	.list--unpicked :global(.ui-dropdown-check:empty) {
		display: none;
	}
	.trail {
		display: inline-flex;
		flex-shrink: 0;
		margin-left: auto;
	}
	.foot {
		margin-top: var(--float-pad);
		padding-top: var(--float-pad);
		border-top: 0.5px solid var(--rule);
	}
</style>
