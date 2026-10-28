<script lang="ts">
	import { RotateCcw } from 'lucide-svelte';
	import Badge from './Badge.svelte';
	import Button from './Button.svelte';

	let {
		label,
		value = $bindable(null),
		stops,
		marks,
		format,
		parse,
		fallback = null,
		fallbackLabel = 'Org default',
		limit = null,
		limitLabel = 'Your limit',
		usage = null,
		disabled = false,
		onchange = undefined
	}: {
		label: string;
		value?: number | null;
		stops: number[];
		marks: number[];
		format: (n: number) => string;
		parse: (text: string) => number | null;
		fallback?: number | null;
		fallbackLabel?: string;
		limit?: number | null;
		limitLabel?: string;
		usage?: number | null;
		disabled?: boolean;
		onchange?: (value: number | null) => void;
	} = $props();

	const uid = $props.id();
	const lo = $derived(Math.log(stops[0]));
	const hi = $derived(Math.log(stops[stops.length - 1]));

	let dragging = $state(false);
	let editing = $state(false);
	let draft = $state('');

	const shown = $derived(value ?? fallback);
	const isDefault = $derived(value == null);
	const over = $derived(value != null && limit != null && value > limit);
	const usable = $derived(limit == null ? stops : stops.filter((s) => s <= limit));

	function pos(n: number) {
		return Math.min(1, Math.max(0, (Math.log(n) - lo) / (hi - lo)));
	}

	function nearestIndex(n: number, list = stops) {
		let best = 0;
		for (let i = 1; i < list.length; i++) {
			if (Math.abs(Math.log(list[i]) - Math.log(n)) < Math.abs(Math.log(list[best]) - Math.log(n)))
				best = i;
		}
		return best;
	}

	function commit(next: number | null) {
		if (next === value) return;
		value = next;
		onchange?.(next);
	}

	function fromTrack(p: number) {
		const n = Math.exp(lo + p * (hi - lo));
		const list = usable.length ? usable : stops;
		commit(list[nearestIndex(n, list)]);
	}

	function step(dir: 1 | -1) {
		const list = usable.length ? usable : stops;
		const at = nearestIndex(shown ?? list[0], list);
		const current = list[at];
		let i = at;
		if (shown != null && dir > 0 && current < shown) i = at;
		else if (shown != null && dir < 0 && current > shown) i = at;
		else i = at + dir;
		commit(list[Math.min(list.length - 1, Math.max(0, i))]);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(1);
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-1);
		else if (e.key === 'Home') commit((usable.length ? usable : stops)[0]);
		else if (e.key === 'End') commit((usable.length ? usable : stops).at(-1)!);
		else return;
		e.preventDefault();
	}

	function startEdit() {
		draft = shown != null ? format(shown) : '';
		editing = true;
	}

	function finishEdit(el: HTMLInputElement) {
		if (!editing) return;
		editing = false;
		const parsed = parse(draft.trim());
		if (parsed != null && parsed > 0) commit(parsed);
		const now = value ?? fallback;
		el.value = now != null ? format(now) : fallbackLabel;
	}
</script>

<div class="amount" class:amount--off={disabled}>
	<div class="head">
		<label class="label" for="{uid}-value">{label}</label>
		<div class="readout">
			{#if isDefault && fallback != null}<Badge>{fallbackLabel}</Badge>{/if}
			{#if !isDefault && fallback != null}
				<Button
					variant="ghost"
					size="sm"
					icon={RotateCcw}
					label="Use {fallbackLabel.toLowerCase()}"
					{disabled}
					onclick={() => commit(null)}
				/>
			{/if}
			<input
				id="{uid}-value"
				class="value"
				class:value--default={isDefault}
				class:value--over={over}
				value={editing ? draft : shown != null ? format(shown) : fallbackLabel}
				{disabled}
				spellcheck="false"
				autocomplete="off"
				aria-describedby="{uid}-note"
				onfocus={(e) => {
					startEdit();
					requestAnimationFrame(() => (e.currentTarget as HTMLInputElement).select());
				}}
				oninput={(e) => (draft = (e.currentTarget as HTMLInputElement).value)}
				onblur={(e) => finishEdit(e.currentTarget as HTMLInputElement)}
				onkeydown={(e) => {
					if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
					if (e.key === 'Escape') {
						editing = false;
						(e.currentTarget as HTMLInputElement).blur();
					}
				}}
			/>
		</div>
	</div>

	<div
		class="track"
		class:track--dragging={dragging}
		style:--at={shown != null ? pos(shown) : 0}
		style:--limit={limit != null ? pos(limit) : 1}
		style:--used={usage != null ? pos(usage) : 0}
	>
		<div class="rail">
			{#if limit != null && pos(limit) < 1}<span class="beyond"></span>{/if}
			{#if usage != null}<span class="used"></span>{/if}
			{#if shown != null}<span class="fill" class:fill--default={isDefault}></span>{/if}
		</div>
		{#if shown != null}
			<span class="thumb" class:thumb--default={isDefault} class:thumb--over={over}></span>
		{/if}
		<input
			type="range"
			class="range"
			min="0"
			max="1000"
			step="1"
			value={shown != null ? Math.round(pos(shown) * 1000) : 0}
			aria-label={label}
			aria-valuetext={shown != null ? format(shown) : fallbackLabel}
			{disabled}
			oninput={(e) => fromTrack(Number((e.currentTarget as HTMLInputElement).value) / 1000)}
			onpointerdown={() => (dragging = true)}
			onpointerup={() => (dragging = false)}
			onpointercancel={() => (dragging = false)}
			{onkeydown}
		/>
	</div>

	<div class="marks" aria-hidden="true">
		{#each marks as mark (mark)}
			<span class="mark" class:mark--beyond={limit != null && mark > limit} style:--p={pos(mark)}
				>{format(mark)}</span
			>
		{/each}
	</div>

	<p class="note" id="{uid}-note">
		{#if over}
			<span class="note--over">Over {limitLabel.toLowerCase()} of {format(limit!)}</span>
		{:else if usage != null}
			Using {format(usage)} right now
		{:else if limit != null}
			{format(limit)} available
		{/if}
	</p>
</div>

<style>
	.amount {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}
	.amount--off {
		opacity: 0.55;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-height: 2rem;
	}
	.label {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.readout {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.value {
		field-sizing: content;
		min-width: 3.5rem;
		height: 2rem;
		padding: 0 0.625rem;
		border: none;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--fill-quiet);
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
		text-align: right;
		transition: background-color var(--fade-in) var(--curve-out);
	}
	.value:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.value:focus-visible {
		outline: none;
		background: var(--bg-raised);
		box-shadow:
			inset 0 0 0 1px var(--accent-solid),
			0 0 0 3px var(--focus-ring);
	}
	.value--default {
		font-weight: var(--weight-medium);
		color: var(--text-muted);
	}
	.value--over {
		color: var(--status-error);
	}
	.track {
		position: relative;
		height: 1.5rem;
		margin: 0 0.5625rem;
	}
	.rail {
		position: absolute;
		inset: 50% 0 auto;
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background: var(--fill-quiet);
		box-shadow: inset 0 0 0 0.5px var(--rule);
		overflow: hidden;
		transform: translateY(-50%);
	}
	.beyond {
		position: absolute;
		inset: 0 0 0 calc(var(--limit) * 100%);
		background: repeating-linear-gradient(
			-45deg,
			color-mix(in oklab, var(--neutral-10) 10%, transparent) 0 2px,
			transparent 2px 5px
		);
	}
	.used {
		position: absolute;
		inset: 0 auto 0 0;
		width: calc(var(--used) * 100%);
		background: color-mix(in oklab, var(--accent-solid) 30%, transparent);
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: calc(var(--at) * 100%);
		background: var(--accent-solid);
		transition: width var(--spring-glide-duration) var(--spring-glide);
	}
	.fill--default {
		background: color-mix(in oklab, var(--neutral-10) 22%, transparent);
	}
	.thumb {
		position: absolute;
		top: 50%;
		left: calc(var(--at) * 100%);
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 50%;
		background: var(--bg-raised);
		box-shadow:
			0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 18%, transparent),
			0 1px 3px color-mix(in oklab, var(--neutral-10) 22%, transparent);
		transform: translate(-50%, -50%);
		transition: left var(--spring-glide-duration) var(--spring-glide);
		pointer-events: none;
	}
	.thumb--default {
		box-shadow:
			inset 0 0 0 1.5px color-mix(in oklab, var(--neutral-10) 30%, transparent),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 14%, transparent);
	}
	.thumb--over {
		box-shadow:
			inset 0 0 0 2px var(--status-error),
			0 1px 3px color-mix(in oklab, var(--neutral-10) 22%, transparent);
	}
	.track--dragging .fill,
	.track--dragging .thumb {
		transition: none;
	}
	.range {
		position: absolute;
		inset: 0 -0.5625rem;
		width: calc(100% + 1.125rem);
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.range:disabled {
		cursor: not-allowed;
	}
	.track:has(.range:focus-visible) .thumb {
		box-shadow:
			0 0 0 3px var(--focus-ring),
			0 1px 3px color-mix(in oklab, var(--neutral-10) 22%, transparent);
	}
	.marks {
		position: relative;
		height: 1rem;
		margin: 0 0.5625rem;
	}
	.mark {
		position: absolute;
		left: calc(var(--p) * 100%);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		transform: translateX(-50%);
	}
	.mark:first-child {
		transform: translateX(-0.5625rem);
	}
	.mark:last-child {
		transform: translateX(calc(-100% + 0.5625rem));
	}
	.mark--beyond {
		color: var(--text-faint);
	}
	.note {
		min-height: 1.125rem;
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.note--over {
		color: var(--status-error);
	}
</style>
