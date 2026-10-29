<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		ArrowDown,
		Check,
		ChevronDown,
		Copy,
		Download,
		Terminal,
		TriangleAlert,
		WrapText
	} from 'lucide-svelte';
	import {
		lineLevel,
		lineText,
		withTimes,
		type LogFilters,
		type LogLevel,
		type LogLine
	} from '$lib/utils/log-lines';
	import Button from './Button.svelte';
	import Input from './Input.svelte';
	import Menu from './Menu.svelte';
	import MenuItem from './MenuItem.svelte';
	import MenuLabel from './MenuLabel.svelte';
	import PopoverPanel from './PopoverPanel.svelte';
	import SearchField from './SearchField.svelte';
	import Spinner from './Spinner.svelte';
	import Tooltip from './Tooltip.svelte';

	let {
		lines,
		loading = false,
		loadingMore = false,
		error = null,
		atStart = false,
		scrolledUp = $bindable(false),
		surface = 'inherit',
		wrap = $bindable(true),
		controls = false,
		toolbar = false,
		filename = 'logs',
		sourceLabel = 'Source',
		onLoadEarlier = undefined,
		onFilters = undefined,
		onExport = undefined,
		caption = null,
		empty = undefined
	}: {
		lines: LogLine[];
		loading?: boolean;
		loadingMore?: boolean;
		error?: string | null;
		atStart?: boolean;
		scrolledUp?: boolean;
		surface?: 'inherit' | 'dark';
		wrap?: boolean;
		controls?: boolean;
		toolbar?: boolean;
		filename?: string;
		sourceLabel?: string;
		onLoadEarlier?: () => Promise<void> | void;
		onFilters?: (filters: LogFilters) => void;
		onExport?: (format: 'text' | 'ndjson') => void;
		caption?: string | null;
		empty?: Snippet;
	} = $props();

	type LevelFilter = 'all' | 'warn' | 'error';
	type Preset = 'all' | '5m' | '15m' | '1h' | '24h' | 'custom';

	const LEVEL_LABEL = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' } as const;
	const LEVELS: { id: LevelFilter; label: string }[] = [
		{ id: 'all', label: 'All levels' },
		{ id: 'warn', label: 'Warnings and errors' },
		{ id: 'error', label: 'Errors only' }
	];
	const PRESETS: { id: Exclude<Preset, 'custom'>; label: string; ms: number }[] = [
		{ id: 'all', label: 'Any time', ms: 0 },
		{ id: '5m', label: 'Last 5 minutes', ms: 5 * 60_000 },
		{ id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
		{ id: '1h', label: 'Last hour', ms: 60 * 60_000 },
		{ id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 }
	];

	let scroller = $state<HTMLDivElement | null>(null);
	let root = $state<HTMLDivElement | null>(null);
	let newWhileScrolled = $state(false);
	let prevCount = 0;
	let prevTail = '';
	let lastLoadMoreAt = 0;

	let query = $state('');
	let level = $state<LevelFilter>('all');
	let preset = $state<Preset>('all');
	let fromText = $state('');
	let toText = $state('');
	let source = $state<string | null>(null);
	let copied = $state(false);
	let errorCursor = $state(-1);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	const hasNumbers = $derived(lines.some((l) => l.lineNo != null));
	const hasLevels = $derived(lines.some((l) => l.level));
	const times = $derived(toolbar ? withTimes(lines) : []);
	const levels = $derived(toolbar ? lines.map(lineLevel) : []);
	const sources = $derived.by(() => {
		if (!toolbar) return [];
		const seen = new Set<string>();
		for (const l of lines) if (l.source) seen.add(l.source);
		return [...seen];
	});
	const hasTimes = $derived(times.some((t) => t != null));

	const window_ = $derived.by((): [number, number] | null => {
		if (preset === 'all') return null;
		if (preset === 'custom') {
			const from = Date.parse(fromText);
			const to = Date.parse(toText);
			return [Number.isNaN(from) ? -Infinity : from, Number.isNaN(to) ? Infinity : to];
		}
		const span = PRESETS.find((p) => p.id === preset)?.ms ?? 0;
		const latest = times.reduce<number>((m, t) => (t != null && t > m ? t : m), 0);
		const end = Math.max(latest, Date.now());
		return [end - span, Infinity];
	});

	const serverWindow = $derived.by((): [number, number | null] | null => {
		if (preset === 'all') return null;
		if (preset === 'custom') {
			const from = Date.parse(fromText);
			const to = Date.parse(toText);
			if (Number.isNaN(from) && Number.isNaN(to)) return null;
			return [Number.isNaN(from) ? 0 : from, Number.isNaN(to) ? null : to];
		}
		const span = PRESETS.find((p) => p.id === preset)?.ms ?? 0;
		return [Date.now() - span, null];
	});

	let filterTimer: ReturnType<typeof setTimeout> | undefined;
	let lastFilters = '';
	$effect(() => {
		const next: LogFilters = {
			query: query.trim(),
			level,
			window: serverWindow,
			source
		};
		const key = JSON.stringify(next);
		if (!onFilters || key === lastFilters) return;
		const first = lastFilters === '';
		lastFilters = key;
		if (first) return;
		clearTimeout(filterTimer);
		const send = onFilters;
		filterTimer = setTimeout(() => send(next), 300);
		return () => clearTimeout(filterTimer);
	});

	const needle = $derived(query.trim().toLowerCase());
	const filtering = $derived(
		toolbar && (!!needle || level !== 'all' || preset !== 'all' || source !== null)
	);

	const visible = $derived.by(() => {
		if (!filtering) return lines;
		const range = window_;
		const out: LogLine[] = [];
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i];
			if (source !== null && l.source !== source) continue;
			if (level !== 'all') {
				const lv = levels[i];
				if (level === 'error' ? lv !== 'error' : lv !== 'error' && lv !== 'warn') continue;
			}
			if (range) {
				const t = times[i];
				if (t == null || t < range[0] || t > range[1]) continue;
			}
			if (needle && !lineText(l).toLowerCase().includes(needle)) continue;
			out.push(l);
		}
		return out;
	});

	const rowKeys = $derived.by(() => {
		const seen = new Map<string, number>();
		return visible.map((l) => {
			const n = seen.get(l.key) ?? 0;
			seen.set(l.key, n + 1);
			return n ? `${l.key}\u0000${n}` : l.key;
		});
	});

	const errorKeys = $derived(
		toolbar ? rowKeys.filter((_, i) => lineLevel(visible[i]) === 'error') : []
	);

	const levelLabel = $derived(LEVELS.find((l) => l.id === level)?.label ?? 'All levels');
	const timeLabel = $derived.by(() => {
		if (preset !== 'custom') return PRESETS.find((p) => p.id === preset)?.label ?? 'Any time';
		const fmt = (v: string) =>
			new Date(v).toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
		if (fromText && toText) return `${fmt(fromText)} to ${fmt(toText)}`;
		if (fromText) return `Since ${fmt(fromText)}`;
		if (toText) return `Until ${fmt(toText)}`;
		return 'Any time';
	});

	$effect(() => {
		const count = visible.length;
		const tail = count > 0 ? visible[count - 1].key : '';
		if (count > prevCount || (count === prevCount && tail !== prevTail)) {
			if (scrolledUp) newWhileScrolled = true;
			else if (!loadingMore) requestAnimationFrame(scrollToBottom);
		}
		if (!scrolledUp) newWhileScrolled = false;
		prevCount = count;
		prevTail = tail;
	});

	$effect(() => {
		void errorKeys;
		errorCursor = -1;
	});

	$effect(() => {
		const q = needle;
		void visible;
		const hl = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
		const Highlight = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
		if (!hl || !Highlight) return;
		if (!q || !scroller) {
			hl.delete('log-match');
			return;
		}
		const el = scroller;
		const frame = requestAnimationFrame(() => {
			const ranges: Range[] = [];
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			let node: Node | null;
			while ((node = walker.nextNode()) && ranges.length < 2000) {
				const text = node.textContent?.toLowerCase() ?? '';
				let at = text.indexOf(q);
				while (at !== -1 && ranges.length < 2000) {
					const r = document.createRange();
					r.setStart(node, at);
					r.setEnd(node, at + q.length);
					ranges.push(r);
					at = text.indexOf(q, at + q.length);
				}
			}
			hl.set('log-match', new Highlight(...ranges));
		});
		return () => {
			cancelAnimationFrame(frame);
			hl.delete('log-match');
		};
	});

	function scrollToBottom() {
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	function jumpToLatest() {
		newWhileScrolled = false;
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	function nextError() {
		if (!errorKeys.length || !scroller) return;
		errorCursor = (errorCursor + 1) % errorKeys.length;
		const key = errorKeys[errorCursor];
		const target = [...scroller.querySelectorAll<HTMLElement>('.lv-line')].find(
			(n) => n.dataset.key === key
		);
		target?.scrollIntoView({ block: 'center' });
	}

	function plain() {
		return visible.map(lineText).join('\n');
	}

	function copyFallback(text: string) {
		const area = document.createElement('textarea');
		area.value = text;
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.append(area);
		area.select();
		document.execCommand('copy');
		area.remove();
	}

	async function copyAll() {
		const text = plain();
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			copyFallback(text);
		}
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1500);
	}

	function download() {
		const blob = new Blob([plain() + '\n'], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${filename}.log`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function clearFilters() {
		query = '';
		level = 'all';
		preset = 'all';
		fromText = '';
		toText = '';
		source = null;
	}

	function findShortcut(el: HTMLElement) {
		el.addEventListener('keydown', onKeydown);
		return () => el.removeEventListener('keydown', onKeydown);
	}

	function onKeydown(e: KeyboardEvent) {
		if (!toolbar || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
		const input = root?.querySelector<HTMLInputElement>('.lv-bar input');
		if (!input) return;
		e.preventDefault();
		input.focus();
		input.select();
	}

	async function handleScroll() {
		const el = scroller;
		if (!el) return;
		scrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 60;
		if (!onLoadEarlier || loadingMore || atStart) return;
		if (el.scrollTop > 80) return;
		const now = Date.now();
		if (now - lastLoadMoreAt < 400) return;
		lastLoadMoreAt = now;
		const prevHeight = el.scrollHeight;
		const prevTop = el.scrollTop;
		await onLoadEarlier();
		requestAnimationFrame(() => {
			const cur = scroller;
			if (!cur) return;
			cur.scrollTop = prevTop + (cur.scrollHeight - prevHeight);
		});
	}
</script>

<div
	bind:this={root}
	class="lv"
	class:lv--dark={surface === 'dark'}
	class:lv--nowrap={!wrap}
	class:lv--numbered={hasNumbers}
	class:lv--levels={hasLevels}
	class:lv--toolbar={toolbar}
	{@attach findShortcut}
>
	{#if toolbar}
		<div class="lv-bar">
			<div class="lv-search">
				<SearchField bind:value={query} size="sm" placeholder="Search logs" />
			</div>
			<Menu placement="bottom-start">
				{#snippet trigger(attrs)}
					<Button {...attrs} variant="ghost" size="sm" iconRight={ChevronDown}>{levelLabel}</Button>
				{/snippet}
				{#each LEVELS as l (l.id)}
					<MenuItem checked={level === l.id} onclick={() => (level = l.id)}>{l.label}</MenuItem>
				{/each}
			</Menu>
			{#if hasTimes}
				<PopoverPanel placement="bottom-start">
					{#snippet trigger(attrs)}
						<Button {...attrs} variant="ghost" size="sm" iconRight={ChevronDown}>{timeLabel}</Button
						>
					{/snippet}
					{#snippet children({ close })}
						<div class="lv-time">
							<div class="lv-presets" role="group" aria-label="Time range">
								{#each PRESETS as p (p.id)}
									<button
										type="button"
										class="lv-preset"
										aria-pressed={preset === p.id}
										onclick={() => {
											preset = p.id;
											fromText = '';
											toText = '';
											close();
										}}
									>
										<span class="lv-preset-check"
											>{#if preset === p.id}<Check size={14} />{/if}</span
										>
										{p.label}
									</button>
								{/each}
							</div>
							<div class="lv-range">
								<label class="lv-range-field">
									<span>From</span>
									<Input
										type="datetime-local"
										size="sm"
										step="1"
										bind:value={fromText}
										oninput={() => (preset = 'custom')}
									/>
								</label>
								<label class="lv-range-field">
									<span>To</span>
									<Input
										type="datetime-local"
										size="sm"
										step="1"
										bind:value={toText}
										oninput={() => (preset = 'custom')}
									/>
								</label>
							</div>
						</div>
					{/snippet}
				</PopoverPanel>
			{/if}
			{#if sources.length > 1}
				<Menu placement="bottom-start" width={320}>
					{#snippet trigger(attrs)}
						<Button {...attrs} variant="ghost" size="sm" iconRight={ChevronDown}
							><span class="lv-source-label">{source ?? `Every ${sourceLabel.toLowerCase()}`}</span
							></Button
						>
					{/snippet}
					<MenuItem checked={source === null} onclick={() => (source = null)}
						>Every {sourceLabel.toLowerCase()}</MenuItem
					>
					<MenuLabel>{sourceLabel}</MenuLabel>
					{#each sources as s (s)}
						<MenuItem checked={source === s} onclick={() => (source = s)}>{s}</MenuItem>
					{/each}
				</Menu>
			{/if}
			{#if caption}<span class="lv-caption">{caption}</span>{/if}
			<span class="lv-count" class:lv-count--after={!!caption} aria-live="polite">
				{#if filtering}{visible.length.toLocaleString()}<span class="lv-count-unit">
						of {lines.length.toLocaleString()}</span
					>{:else}{lines.length.toLocaleString()}<span class="lv-count-unit">
						{lines.length === 1 ? 'line' : 'lines'}</span
					>{/if}
			</span>
			{#if errorKeys.length}
				<Tooltip text="Jump to the next error">
					<Button variant="ghost" size="sm" icon={TriangleAlert} onclick={nextError}
						>{errorCursor >= 0
							? `${errorCursor + 1} of ${errorKeys.length}`
							: errorKeys.length}</Button
					>
				</Tooltip>
			{/if}
			<Tooltip text={wrap ? 'Stop wrapping lines' : 'Wrap lines'}>
				<Button
					variant="ghost"
					size="sm"
					icon={WrapText}
					label="Wrap lines"
					aria-pressed={wrap}
					onclick={() => (wrap = !wrap)}
				/>
			</Tooltip>
			<Tooltip text={copied ? 'Copied' : filtering ? 'Copy the lines shown' : 'Copy all lines'}>
				<Button
					variant="ghost"
					size="sm"
					icon={copied ? Check : Copy}
					label="Copy logs"
					disabled={!visible.length}
					onclick={copyAll}
				/>
			</Tooltip>
			{#if onExport}
				<Menu placement="bottom-end">
					{#snippet trigger(attrs)}
						<Button {...attrs} variant="ghost" size="sm" icon={Download} label="Download logs" />
					{/snippet}
					<MenuItem disabled={!visible.length} onclick={download}>Download what's shown</MenuItem>
					<MenuItem onclick={() => onExport('text')}>Export every matching line</MenuItem>
					<MenuItem onclick={() => onExport('ndjson')}>Export as NDJSON</MenuItem>
				</Menu>
			{:else}
				<Tooltip text="Download">
					<Button
						variant="ghost"
						size="sm"
						icon={Download}
						label="Download logs"
						disabled={!visible.length}
						onclick={download}
					/>
				</Tooltip>
			{/if}
		</div>
	{/if}
	{#if loading && lines.length === 0}
		<div class="lv-empty">
			<Spinner size={16} />
			<span>Loading logs</span>
		</div>
	{:else if lines.length && !visible.length}
		<div class="lv-empty">
			<span>No lines match</span>
			<Button variant="secondary" size="sm" onclick={clearFilters}>Clear filters</Button>
		</div>
	{:else if lines.length}
		<div class="lv-scroll" bind:this={scroller} onscroll={handleScroll}>
			{#if loadingMore}
				<div class="lv-more"><Spinner size={12} /> Loading earlier logs</div>
			{:else if atStart}
				<div class="lv-more">Start of available logs</div>
			{/if}
			<div class="lv-body">
				{#each visible as line, i (rowKeys[i])}
					<div
						class="lv-line"
						data-level={line.level ?? (toolbar ? lineLevel(line) : undefined)}
						data-key={rowKeys[i]}
						class:lv-line--current={errorCursor >= 0 && errorKeys[errorCursor] === rowKeys[i]}
					>
						{#if hasNumbers}<span class="lv-no">{line.lineNo ?? ''}</span>{/if}
						{#if hasLevels}<span class="lv-level"
								>{line.level ? LEVEL_LABEL[line.level as LogLevel] : ''}</span
							>{/if}
						<span class="lv-text">{@html line.html}</span>
					</div>
				{/each}
			</div>
		</div>
		{#if controls && !toolbar}
			<div class="lv-tools">
				<button
					type="button"
					class="lv-tool"
					class:lv-tool--on={wrap}
					aria-pressed={wrap}
					aria-label="Wrap lines"
					title="Wrap lines"
					onclick={() => (wrap = !wrap)}
				>
					<WrapText size={14} />
				</button>
			</div>
		{/if}
		{#if newWhileScrolled}
			<button type="button" class="lv-newlogs" onclick={jumpToLatest}>
				<ArrowDown size={12} /><span class="lv-newlogs-label">New logs</span>
			</button>
		{/if}
	{:else if error}
		<div class="lv-empty lv-empty--error">
			<TriangleAlert size={16} />
			<span>{error}</span>
		</div>
	{:else if empty}
		{@render empty()}
	{:else}
		<div class="lv-empty">
			<Terminal size={16} />
			<span>No output yet</span>
		</div>
	{/if}
</div>

<style>
	.lv {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.125rem;
		font-weight: var(--weight-regular);
		color: var(--console-text);
	}
	.lv--dark {
		background-color: var(--console-bg);
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: inset 0 0 0 1px var(--console-edge);
		padding: 0.5rem 0;
	}
	.lv-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--console-strong) 18%, transparent) transparent;
	}
	.lv-body {
		display: flex;
		flex-direction: column;
		min-width: 100%;
	}
	.lv--nowrap .lv-body {
		width: max-content;
	}
	.lv-line {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		min-height: 1.125rem;
		transition: background-color 80ms ease;
	}
	.lv--dark .lv-line {
		padding: 0 0.875rem;
	}
	.lv-line:hover {
		background: var(--console-quiet);
	}
	.lv-line[data-level='error'] {
		background: color-mix(in oklab, var(--red-7) 7%, transparent);
	}
	.lv-line[data-level='warn'] {
		background: color-mix(in oklab, var(--amber-7) 6%, transparent);
	}
	.lv-line[data-level='error']:hover {
		background: color-mix(in oklab, var(--red-7) 11%, transparent);
	}
	.lv-line[data-level='warn']:hover {
		background: color-mix(in oklab, var(--amber-7) 10%, transparent);
	}
	.lv-no {
		flex-shrink: 0;
		min-width: 3ch;
		color: var(--console-faint);
		text-align: right;
		font-variant-numeric: tabular-nums;
		user-select: none;
	}
	.lv-level {
		flex-shrink: 0;
		width: 3ch;
		color: var(--console-faint);
		font-weight: var(--weight-medium);
		user-select: none;
	}
	.lv-line[data-level='info'] .lv-level {
		color: var(--blue-8);
	}
	.lv-line[data-level='warn'] .lv-level {
		color: var(--amber-9);
	}
	.lv-line[data-level='error'] .lv-level {
		color: var(--red-9);
	}
	.lv-text {
		flex: 1;
		min-width: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.lv--nowrap .lv-text {
		flex: none;
		white-space: pre;
		overflow-wrap: normal;
	}
	.lv-text :global(.log-ts) {
		display: inline-block;
		margin: 0 0.75rem 0 0;
		padding: 0;
		border-radius: 0;
		background: none;
		color: var(--console-faint);
		font-size: inherit;
		font-weight: var(--weight-regular);
		line-height: inherit;
		letter-spacing: 0;
		cursor: text;
		transition: color var(--dur-fast) ease;
	}
	.lv-text :global(.log-pod) {
		display: inline-block;
		margin-right: 0.75rem;
		color: var(--console-dim);
	}
	.lv-line:hover :global(.log-ts) {
		background: none;
		color: var(--console-dim);
	}
	.lv-more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.375rem 0 0.625rem;
		color: var(--console-faint);
		font-family: var(--font-sans);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.lv-tools {
		position: absolute;
		top: 0.375rem;
		right: 0.375rem;
		display: flex;
		gap: 0.125rem;
		padding: 0.125rem;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--material-glass-bg);
		backdrop-filter: var(--material-glass-filter);
		box-shadow: var(--shadow-floating);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.lv:hover .lv-tools,
	.lv-tools:focus-within {
		opacity: 1;
	}
	.lv-tool {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: none;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.lv-tool:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.lv-tool--on {
		background: var(--accent-subtle);
		color: var(--accent-9);
	}
	.lv-tool--on:hover {
		background: var(--accent-3);
		color: var(--accent-9);
	}
	.lv-newlogs {
		position: absolute;
		bottom: 0.75rem;
		left: 50%;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 1.75rem;
		padding: 0 0.75rem 0 0.625rem;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--material-glass-bg);
		backdrop-filter: var(--material-glass-filter);
		box-shadow: var(--shadow-floating);
		color: var(--text-default);
		font-family: var(--font-sans);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		cursor: pointer;
		translate: -50% 0;
		animation: lv-rise var(--spring-pop-duration) var(--spring-pop) both;
		transition: transform var(--spring-press-duration) var(--spring-press);
	}
	.lv-newlogs:active {
		transform: scale(0.96);
	}
	.lv-newlogs-label {
		display: block;
		text-box: trim-both cap alphabetic;
	}
	@keyframes lv-rise {
		from {
			opacity: 0;
			transform: translateY(0.5rem) scale(0.94);
		}
	}
	.lv-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		color: var(--console-faint);
		font-family: var(--font-sans);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.lv-empty--error {
		color: var(--status-error);
	}
	.lv-bar {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 0.25rem;
		padding: 0 0 0.5rem;
		font-family: var(--font-sans);
	}
	.lv--dark .lv-bar {
		padding: 0 0.5rem 0.5rem;
	}
	.lv-bar :global(:is(.button, .search)) {
		border-radius: 999px;
		corner-shape: round;
	}
	.lv-bar :global(.button[aria-pressed='true']) {
		background: var(--console-quiet, var(--bg-hover));
		color: var(--console-text, var(--text-default));
	}
	.lv-search {
		flex: 0 1 14rem;
		min-width: 7rem;
		margin-right: 0.25rem;
	}
	.lv-source-label {
		display: inline-block;
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: bottom;
	}
	.lv-caption {
		margin-left: auto;
		padding-left: 0.5rem;
		color: var(--text-faint);
		font-size: var(--text-footnote);
		white-space: nowrap;
	}
	.lv-count.lv-count--after {
		margin-left: 0;
	}
	.lv-count {
		margin-left: auto;
		padding: 0 0.5rem;
		color: var(--text-faint);
		font-size: var(--text-footnote);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.lv--toolbar {
		container-type: inline-size;
	}
	@container (max-width: 40rem) {
		.lv-count-unit {
			display: none;
		}
	}
	.lv-time {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 17rem;
		padding: 0.375rem;
	}
	.lv-presets {
		display: flex;
		flex-direction: column;
	}
	.lv-preset {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2rem;
		padding: 0 0.5rem;
		border: none;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: none;
		color: var(--text-default);
		font-size: var(--text-callout);
		text-align: left;
		cursor: pointer;
	}
	.lv-preset:hover {
		background: var(--bg-hover);
	}
	.lv-preset-check {
		display: grid;
		place-items: center;
		width: 1rem;
		color: var(--accent);
	}
	.lv-range {
		display: grid;
		gap: 0.5rem;
		padding: 0.5rem 0.5rem 0.25rem;
		border-top: 1px solid var(--rule);
	}
	.lv-range-field {
		display: grid;
		gap: 0.25rem;
		color: var(--text-muted);
		font-size: var(--text-footnote);
	}
	.lv-line--current {
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--red-8) 60%, transparent);
	}
	:global(::highlight(log-match)) {
		background-color: color-mix(in oklab, var(--amber-7) 45%, transparent);
		color: inherit;
	}
</style>
