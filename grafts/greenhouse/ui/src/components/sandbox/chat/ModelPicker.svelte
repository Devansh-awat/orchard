<script lang="ts">
	import { tick } from 'svelte';
	import { animate } from 'motion';
	import {
		Check,
		ChevronDown,
		ChevronLeft,
		ChevronRight,
		GripVertical,
		Search,
		Settings,
		Star
	} from 'lucide-svelte';
	import type { Placement } from '@floating-ui/dom';
	import { PopoverPanel } from '@orchardlabs/graft-ui';
	import { motion } from '@orchardlabs/graft-ui/utils/motion.svelte';
	import {
		ocEffortLabel,
		ocIsFast,
		ocModelGroups,
		ocModelKey,
		ocModelLabel,
		ocProviderKind,
		ocSearchModels,
		ocShortModelName,
		type OcModel
	} from '../opencode';
	import type { ChatSessionStore } from './session-store.svelte';
	import { modelFavourites } from './model-favourites.svelte';
	import ProviderIcon from './ProviderIcon.svelte';

	let {
		store,
		placement = 'top-start',
		open = $bindable(false)
	}: { store: ChatSessionStore; placement?: Placement; open?: boolean } = $props();
	const uid = $props.id();

	type View = 'main' | 'effort' | 'edit';

	const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
	const PICK_KEY = MAC ? '⌃⌘' : 'Ctrl+Alt+';
	const FAST_KEY = MAC ? '⌘⇧E' : 'Ctrl+Shift+E';
	const CYCLE_KEY = MAC ? '⌘⇧/' : 'Ctrl+Shift+/';

	let view = $state<View>('main');
	let query = $state('');
	let cursor = $state(0);
	let armed = $state<string | null>(null);
	let dragging = $state<string | null>(null);
	let triggerEl = $state<HTMLButtonElement | undefined>(undefined);
	let rootEl = $state<HTMLDivElement | undefined>(undefined);
	let searchEl = $state<HTMLInputElement | undefined>(undefined);

	$effect(() => {
		modelFavourites.use(store.self?.id);
	});

	const models = $derived(store.models);
	const favourites = $derived(modelFavourites.resolve(models));
	const favouriteKeys = $derived(new Set(favourites.map(ocModelKey)));
	const searching = $derived(query.trim().length > 0);
	const results = $derived(ocModelGroups(ocSearchModels(models, query)));
	const rows = $derived(searching ? results.flatMap((g) => g.models) : favourites);
	const active = $derived(rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1));
	const currentKey = $derived(`${store.providerID}/${store.modelID}`);
	const modelLabel = $derived(ocShortModelName(store.model?.name ?? store.modelID));
	const variantLabel = $derived(store.variant ? ocEffortLabel(store.variant) : null);
	const fast = $derived(store.model ? ocIsFast(store.model) : false);
	const allGroups = $derived(ocModelGroups(models));

	$effect(() => {
		if (!open) return;
		const timer = setTimeout(() => searchEl?.focus(), 0);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		if (open) return;
		const timer = setTimeout(() => {
			view = 'main';
			query = '';
			cursor = 0;
		}, 200);
		return () => clearTimeout(timer);
	});

	function effortFor(model: OcModel): string | null {
		return store.variant && model.variants.includes(store.variant)
			? ocEffortLabel(store.variant)
			: null;
	}

	function pick(model: OcModel, close = true) {
		store.pickModel(model);
		if (close) open = false;
	}

	async function go(next: View) {
		view = next;
		await tick();
		if (next === 'main') searchEl?.focus();
		else rootEl?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
	}

	async function keepFocus() {
		await tick();
		if (rootEl && !rootEl.contains(document.activeElement)) rootEl.focus();
	}

	function toggleStar(model: OcModel) {
		modelFavourites.toggle(model, models);
		void keepFocus();
	}

	function moveFavourite(from: number, to: number) {
		modelFavourites.move(from, to, models);
		cursor = to;
	}

	function onSearchKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (rows.length === 0) return;
			const step = e.key === 'ArrowDown' ? 1 : -1;
			if (e.altKey && !searching && active >= 0) {
				const to = active + step;
				if (to >= 0 && to < favourites.length) moveFavourite(active, to);
				return;
			}
			cursor = (active + step + rows.length) % rows.length;
			void tick().then(() =>
				document.getElementById(`${uid}-opt-${cursor}`)?.scrollIntoView({ block: 'nearest' })
			);
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			const model = rows[active];
			if (model) pick(model);
		}
	}

	function onPanelKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (view !== 'main') {
			e.preventDefault();
			e.stopPropagation();
			void go('main');
			return;
		}
		if (query) {
			e.preventDefault();
			e.stopPropagation();
			query = '';
		}
	}

	function visible(): boolean {
		const el = triggerEl;
		if (!el || !el.isConnected) return false;
		return typeof el.checkVisibility === 'function'
			? el.checkVisibility()
			: el.offsetParent !== null;
	}

	function onWindowKey(e: KeyboardEvent) {
		if (e.defaultPrevented || e.isComposing || !visible()) return;
		const digit = /^Digit([1-9])$/.exec(e.code);
		const pickCombo = MAC
			? e.ctrlKey && e.metaKey && !e.altKey
			: e.ctrlKey && e.altKey && !e.metaKey;
		if (digit && pickCombo && !e.shiftKey) {
			const model = favourites[Number(digit[1]) - 1];
			if (!model) return;
			e.preventDefault();
			pick(model, false);
			return;
		}
		const primary = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
		if (!primary || !e.shiftKey || e.altKey) return;
		if (e.code === 'KeyE' && store.fastSibling) {
			e.preventDefault();
			store.toggleFast();
		} else if (e.code === 'Slash' && store.variants.length > 0) {
			e.preventDefault();
			store.cycleVariant();
		}
	}

	function knob(on: () => boolean) {
		return (el: HTMLElement) => {
			let first = true;
			$effect(() => {
				const x = on() ? 12 : 0;
				if (first) {
					first = false;
					animate(el, { x }, { duration: 0 });
					return;
				}
				if (!motion(el, { x }, 'snappy')) animate(el, { x }, { duration: 0 });
			});
		};
	}

	function dragStart(e: DragEvent, key: string) {
		if (armed !== key) {
			e.preventDefault();
			return;
		}
		dragging = key;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', key);
		}
	}

	function dragOver(e: DragEvent, key: string) {
		if (!dragging) return;
		e.preventDefault();
		if (dragging === key) return;
		const from = favourites.findIndex((m) => ocModelKey(m) === dragging);
		const to = favourites.findIndex((m) => ocModelKey(m) === key);
		if (from >= 0 && to >= 0) moveFavourite(from, to);
	}

	function dragEnd() {
		dragging = null;
		armed = null;
	}
</script>

<svelte:window onkeydown={onWindowKey} onpointerup={() => !dragging && (armed = null)} />

{#snippet favouriteRow(model: OcModel, index: number, editing: boolean)}
	{@const key = ocModelKey(model)}
	{@const effort = effortFor(model)}
	<div
		id={editing ? undefined : `${uid}-opt-${index}`}
		class="mp-row mp-row--model"
		class:mp-row--active={!editing && index === active}
		class:mp-row--dragging={dragging === key}
		role="option"
		tabindex="-1"
		aria-selected={key === currentKey}
		draggable={armed === key}
		ondragstart={(e) => dragStart(e, key)}
		ondragover={(e) => dragOver(e, key)}
		ondragend={dragEnd}
		onpointerdown={(e) => {
			if (!(e.target as Element).closest('.mp-grip')) e.preventDefault();
		}}
		onmouseenter={() => !editing && (cursor = index)}
		onclick={() => !editing && pick(model)}
		onkeydown={(e) => {
			if (!editing && e.key === 'Enter') pick(model);
		}}
	>
		<span
			class="mp-grip"
			title="Drag to reorder (⌥↑ ⌥↓)"
			aria-hidden="true"
			onpointerdown={() => (armed = key)}
		>
			<GripVertical size={14} strokeWidth={1.75} />
		</span>
		<ProviderIcon kind={ocProviderKind(model)} />
		<span class="mp-name">{ocModelLabel(model)}</span>
		{#if ocIsFast(model)}<span class="mp-meta">Fast</span>{/if}
		{#if effort && !editing}<span class="mp-meta">{effort}</span>{/if}
		<span class="mp-spacer"></span>
		{#if editing}
			<button
				type="button"
				class="mp-star mp-star--on"
				aria-label="Remove {ocModelLabel(model)} from favourites"
				title="Remove from favourites"
				onclick={(e) => {
					e.stopPropagation();
					toggleStar(model);
				}}
			>
				<Star size={14} strokeWidth={1.75} fill="currentColor" />
			</button>
		{:else if key === currentKey}
			<Check size={14} strokeWidth={1.75} class="mp-check" aria-label="Current model" />
		{:else if index < 9}
			<span class="mp-key">{PICK_KEY}{index + 1}</span>
		{/if}
	</div>
{/snippet}

{#snippet modelRow(model: OcModel, index: number | null)}
	{@const key = ocModelKey(model)}
	{@const starred = favouriteKeys.has(key)}
	<div
		id={index === null ? undefined : `${uid}-opt-${index}`}
		class="mp-row mp-row--model mp-row--plain"
		class:mp-row--active={index !== null && index === active}
		role="option"
		tabindex="-1"
		aria-selected={key === currentKey}
		onpointerdown={(e) => e.preventDefault()}
		onmouseenter={() => index !== null && (cursor = index)}
		onclick={() => index !== null && pick(model)}
		onkeydown={(e) => {
			if (index !== null && e.key === 'Enter') pick(model);
		}}
	>
		<ProviderIcon kind={ocProviderKind(model)} />
		<span class="mp-name">{ocModelLabel(model)}</span>
		{#if ocIsFast(model)}<span class="mp-meta">Fast</span>{/if}
		<span class="mp-spacer"></span>
		{#if index !== null && key === currentKey}
			<Check size={14} strokeWidth={1.75} class="mp-check" aria-label="Current model" />
		{/if}
		<button
			type="button"
			class="mp-star"
			class:mp-star--on={starred}
			aria-pressed={starred}
			aria-label={starred
				? `Remove ${ocModelLabel(model)} from favourites`
				: `Add ${ocModelLabel(model)} to favourites`}
			title={starred ? 'Remove from favourites' : 'Add to favourites'}
			onpointerdown={(e) => e.preventDefault()}
			onclick={(e) => {
				e.stopPropagation();
				toggleStar(model);
			}}
		>
			<Star size={14} strokeWidth={1.75} fill={starred ? 'currentColor' : 'none'} />
		</button>
	</div>
{/snippet}

<PopoverPanel bind:open {placement} class="mp-panel">
	{#snippet trigger(props, isOpen)}
		<button
			bind:this={triggerEl}
			type="button"
			class="model"
			class:model--open={isOpen}
			aria-label="Model and effort"
			title="Model and effort"
			{...props}
		>
			<span class="model-name" data-align="inset">{modelLabel}</span>
			{#if variantLabel}<span class="model-effort">{variantLabel}</span>{/if}
			<ChevronDown size={16} strokeWidth={1.75} />
		</button>
	{/snippet}
	{#snippet children()}
		<div
			class="mp"
			bind:this={rootEl}
			tabindex="-1"
			role="presentation"
			onkeydown={onPanelKey}
			onclick={(e) => e.stopPropagation()}
		>
			{#if view === 'main'}
				<label class="mp-search">
					<Search size={16} strokeWidth={1.75} />
					<input
						bind:this={searchEl}
						bind:value={query}
						type="text"
						placeholder="Search models"
						aria-label="Search models"
						role="combobox"
						aria-expanded="true"
						aria-controls="{uid}-list"
						aria-activedescendant={active >= 0 ? `${uid}-opt-${active}` : undefined}
						autocomplete="off"
						spellcheck="false"
						oninput={() => (cursor = 0)}
						onkeydown={onSearchKey}
					/>
				</label>
				<div class="mp-list" id="{uid}-list" role="listbox" aria-label="Models">
					{#if models.length === 0}
						<div class="mp-empty">
							{store.modelsFailed ? 'The agent did not list any models' : 'Loading models'}
						</div>
					{:else if searching}
						{#each results as group (group.name)}
							<div class="mp-group">{group.name}</div>
							{#each group.models as model (ocModelKey(model))}
								{@render modelRow(model, rows.indexOf(model))}
							{/each}
						{:else}
							<div class="mp-empty">No models match</div>
						{/each}
					{:else}
						{#each favourites as model, i (ocModelKey(model))}
							{@render favouriteRow(model, i, false)}
						{:else}
							<div class="mp-empty">No favourites. Search to add some.</div>
						{/each}
					{/if}
				</div>
				{#if store.variants.length > 0 || store.fastSibling}
					<div class="mp-sep"></div>
				{/if}
				{#if store.variants.length > 0}
					<button
						type="button"
						class="mp-row"
						aria-haspopup="listbox"
						onpointerdown={(e) => e.preventDefault()}
						onclick={() => go('effort')}
					>
						<span class="mp-name">Effort</span>
						<span class="mp-spacer"></span>
						<span class="mp-value">{ocEffortLabel(store.variant)}</span>
						<ChevronRight size={16} strokeWidth={1.75} class="mp-chev" />
					</button>
				{/if}
				{#if store.fastSibling}
					<button
						type="button"
						class="mp-row"
						role="switch"
						aria-checked={fast}
						title="Fast ({FAST_KEY})"
						onpointerdown={(e) => e.preventDefault()}
						onclick={() => store.toggleFast()}
					>
						<span class="mp-name">Fast</span>
						<span class="mp-spacer"></span>
						<span class="mp-key">{FAST_KEY}</span>
						<span class="mp-switch" class:mp-switch--on={fast} aria-hidden="true">
							<span class="mp-knob" {@attach knob(() => fast)}></span>
						</span>
					</button>
				{/if}
				<div class="mp-foot">
					<button
						type="button"
						class="mp-foot-btn"
						onpointerdown={(e) => e.preventDefault()}
						onclick={() => go('edit')}
					>
						<Settings size={14} strokeWidth={1.75} /> Edit
					</button>
					<span class="mp-spacer"></span>
					<button
						type="button"
						class="mp-foot-btn"
						disabled={store.variants.length === 0}
						title="Cycle effort ({CYCLE_KEY})"
						onpointerdown={(e) => e.preventDefault()}
						onclick={() => store.cycleVariant()}
					>
						<kbd class="mp-kbd">{CYCLE_KEY}</kbd> Cycle effort
					</button>
				</div>
			{:else if view === 'effort'}
				<button type="button" class="mp-back" data-autofocus onclick={() => go('main')}>
					<ChevronLeft size={16} strokeWidth={1.75} />
					<span>Effort</span>
				</button>
				<div class="mp-list" role="listbox" aria-label="Effort">
					{#each [null, ...store.variants] as variant (variant ?? '')}
						<button
							type="button"
							class="mp-row"
							role="option"
							aria-selected={store.variant === variant}
							onpointerdown={(e) => e.preventDefault()}
							onclick={() => {
								store.pickVariant(variant);
								void go('main');
							}}
						>
							<span class="mp-name">{ocEffortLabel(variant)}</span>
							<span class="mp-spacer"></span>
							{#if store.variant === variant}
								<Check size={14} strokeWidth={1.75} class="mp-check" />
							{/if}
						</button>
					{/each}
				</div>
			{:else}
				<div class="mp-head">
					<button type="button" class="mp-back" onclick={() => go('main')}>
						<ChevronLeft size={16} strokeWidth={1.75} />
						<span>Favourites</span>
					</button>
					<span class="mp-spacer"></span>
					<button type="button" class="mp-foot-btn" data-autofocus onclick={() => go('main')}>
						Done
					</button>
				</div>
				<div class="mp-list mp-list--edit">
					<div role="listbox" aria-label="Favourites">
						{#each favourites as model, i (ocModelKey(model))}
							{@render favouriteRow(model, i, true)}
						{:else}
							<div class="mp-empty">Star models below to add them</div>
						{/each}
					</div>
					{#each allGroups as group (group.name)}
						<div class="mp-group">{group.name}</div>
						<div role="listbox" aria-label={group.name}>
							{#each group.models as model (ocModelKey(model))}
								{@render modelRow(model, null)}
							{/each}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/snippet}
</PopoverPanel>

<style>
	:global(.ui-popover.mp-panel) {
		width: 20rem;
		padding: var(--space-1);
	}

	.mp {
		display: flex;
		flex-direction: column;
		min-height: 0;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		font-weight: 400;
		color: var(--text-default);
		outline: none;
	}

	.model {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
		max-width: 16rem;
		height: 1.75rem;
		margin-left: calc(-1 * var(--space-2));
		padding: 0 var(--space-1) 0 var(--space-2);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
		cursor: pointer;
		white-space: nowrap;
		transition: background-color var(--dur-fast);
	}

	.model:hover,
	.model--open {
		background: var(--bg-hover);
	}

	.model-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.model-effort {
		color: var(--text-muted);
	}

	@container chat-pane (max-width: 32rem) {
		.model-effort {
			display: none;
		}
	}

	.model :global(svg) {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.mp-search {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
		height: 2rem;
		margin-bottom: var(--space-1);
		padding: 0 var(--space-2);
		border-bottom: 1px solid var(--border-default);
		color: var(--text-muted);
	}

	.mp-search input {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: none;
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
	}

	.mp-search input:focus-visible {
		outline: none;
	}

	.mp-search input::placeholder {
		color: var(--text-faint);
	}

	.mp-list {
		display: flex;
		flex-direction: column;
		min-height: 0;
		max-height: 18rem;
		overflow-y: auto;
	}

	.mp-list--edit {
		max-height: 24rem;
	}

	.mp-group {
		padding: var(--space-2) var(--space-2) var(--space-1);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-faint);
	}

	.mp-empty {
		padding: var(--space-2);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.mp-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
		width: 100%;
		min-width: 0;
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.mp-row--model {
		padding-left: var(--space-1);
	}

	.mp-row--plain {
		padding-left: var(--space-2);
		padding-right: 0;
	}

	.mp-row:hover,
	.mp-row--active,
	.mp-row:focus-visible {
		background: var(--bg-hover);
		outline: none;
	}

	.mp-row--dragging {
		opacity: 0.5;
	}

	.mp-grip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1.75rem;
		flex-shrink: 0;
		color: var(--text-faint);
		cursor: grab;
	}

	.mp-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mp-meta,
	.mp-value {
		flex-shrink: 0;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.mp-spacer {
		flex: 1;
		min-width: var(--space-2);
	}

	.mp-key {
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
		white-space: nowrap;
	}

	.mp :global(.mp-check) {
		flex-shrink: 0;
		color: var(--text-default);
	}

	.mp :global(.mp-chev) {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.mp-star {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition: color var(--dur-fast);
	}

	.mp-star:hover {
		color: var(--text-default);
	}

	.mp-star--on {
		color: var(--text-default);
	}

	.mp-sep {
		flex-shrink: 0;
		height: 1px;
		margin: var(--space-1) 0;
		background: var(--border-default);
	}

	.mp-switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1rem;
		padding: 0.125rem;
		border-radius: var(--radius-pill);
		background: var(--fill-medium);
		transition: background-color var(--dur-fast);
	}

	.mp-switch--on {
		background: var(--accent);
	}

	.mp-knob {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		box-shadow: var(--elev-1);
	}

	.mp-foot,
	.mp-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
		height: 2rem;
		margin-top: var(--space-1);
		padding-top: var(--space-1);
		border-top: 1px solid var(--border-default);
	}

	.mp-head {
		margin: 0 0 var(--space-1);
		padding: 0 0 var(--space-1);
		border-top: none;
		border-bottom: 1px solid var(--border-default);
	}

	.mp-foot-btn,
	.mp-back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.mp-back {
		flex-shrink: 0;
		padding-left: var(--space-1);
		font-weight: 600;
		color: var(--text-default);
	}

	.mp-foot-btn:hover:not(:disabled),
	.mp-back:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.mp-foot-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.mp-kbd {
		display: inline-flex;
		align-items: center;
		height: 1.25rem;
		padding: 0 var(--space-1);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		font-family: inherit;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}
</style>
