<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { createQuery } from '@tanstack/svelte-query';
	import { selectedOrganization } from '$lib/stores';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { Package, Rocket, Search, X, Database, LayoutTemplate } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import {
		motionPopover as motionPopoverBase,
		motionBackdrop as motionBackdropBase,
		motionStagger as motionStaggerBase
	} from '$lib/utils/motion.svelte';

	let open = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);

	const orgSlug = $derived($page.params.orgSlug ?? $selectedOrganization?.slug);

	const overview = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: open && !!orgSlug
	}));

	interface TreeItem {
		id: string;
		name: string;
		type: 'project' | 'deployment' | 'ingress' | 'database' | 'templateInstance';
		href: string;
		children?: TreeItem[];
	}

	type ProjectRef = { id: string; name: string; slug: string };
	type OverviewLite = {
		deployments?: Array<{ id: string; name: string; project?: ProjectRef }>;
		databases?: Array<{ id: string; name: string; project?: ProjectRef }>;
		projects?: ProjectRef[];
	};

	const searchTree = $derived.by<TreeItem[]>(() => {
		const data = overview.data as OverviewLite | undefined;
		if (!data || !orgSlug) return [];
		const projects = new Map<string, TreeItem>();
		const ensureProject = (p: ProjectRef) => {
			let node = projects.get(p.id);
			if (!node) {
				node = {
					id: p.id,
					name: p.name,
					type: 'project',
					href: `/${orgSlug}/projects/${p.slug}`,
					children: []
				};
				projects.set(p.id, node);
			}
			return node;
		};
		for (const d of data.deployments ?? []) {
			if (!d.project) continue;
			ensureProject(d.project).children!.push({
				id: d.id,
				name: d.name,
				type: 'deployment',
				href: `/${orgSlug}/deployments/${d.id}`
			});
		}
		for (const db of data.databases ?? []) {
			if (!db.project) continue;
			ensureProject(db.project).children!.push({
				id: db.id,
				name: db.name,
				type: 'database',
				href: `/${orgSlug}/databases/${db.id}`
			});
		}
		for (const p of data.projects ?? []) ensureProject(p);
		return [...projects.values()];
	});

	export function openSearch() {
		open = true;
		setTimeout(() => {
			const input = document.querySelector('.quick-search-input') as HTMLInputElement;
			input?.focus();
		}, 0);
	}

	function getIcon(type: TreeItem['type']) {
		switch (type) {
			case 'project':
				return Package;
			case 'deployment':
				return Rocket;
			case 'database':
				return Database;
			case 'templateInstance':
				return LayoutTemplate;
			default:
				return Package;
		}
	}

	function typeLabel(type: TreeItem['type']) {
		switch (type) {
			case 'templateInstance':
				return 'template';
			case 'deployment':
				return 'app';
			default:
				return type;
		}
	}

	// ── Fuzzy match (substring + subsequence) returning a score and char ranges ──
	type Span = [number, number];
	interface Match {
		score: number;
		spans: Span[];
	}

	function fuzzy(text: string, q: string): Match | null {
		if (!q) return null;
		const t = text.toLowerCase();
		const Q = q.toLowerCase();
		if (t === Q) return { score: 1000, spans: [[0, t.length]] };
		const idx = t.indexOf(Q);
		if (idx === 0) return { score: 850 - (t.length - Q.length), spans: [[0, Q.length]] };
		if (idx > 0)
			return { score: 700 - idx * 3 - (t.length - Q.length), spans: [[idx, idx + Q.length]] };
		// Word-boundary subsequence: prefer matches that start at word boundaries.
		let ti = 0;
		let qi = 0;
		let runStart = -1;
		const spans: Span[] = [];
		let boundaryHits = 0;
		while (ti < t.length && qi < Q.length) {
			if (t[ti] === Q[qi]) {
				if (runStart < 0) {
					runStart = ti;
					if (ti === 0 || /[\s\-_./]/.test(t[ti - 1])) boundaryHits++;
				}
				qi++;
				if (qi === Q.length || t[ti + 1] !== Q[qi]) {
					spans.push([runStart, ti + 1]);
					runStart = -1;
				}
			}
			ti++;
		}
		if (qi < Q.length) return null;
		// Penalize gappy matches; reward boundary-aligned ones.
		const span = (spans[spans.length - 1]?.[1] ?? 0) - spans[0][0];
		return { score: 350 - (span - Q.length) * 2 + boundaryHits * 25, spans };
	}

	// ── Walk the tree, attaching the project ancestor to each leaf ──
	interface Flat {
		item: TreeItem;
		project?: TreeItem;
	}
	function flatten(items: TreeItem[], project?: TreeItem): Flat[] {
		const out: Flat[] = [];
		for (const item of items) {
			if (item.type === 'ingress') continue; // ingress detail route is gone
			if (item.type === 'project') {
				out.push({ item, project: item });
				if (item.children) out.push(...flatten(item.children, item));
			} else {
				out.push({ item, project });
				if (item.children) out.push(...flatten(item.children, project));
			}
		}
		return out;
	}

	interface Hit {
		item: TreeItem;
		project?: TreeItem;
		score: number;
		spans: Span[];
		via: 'self' | 'project';
	}
	interface Group {
		key: string;
		project?: TreeItem;
		projectSpans?: Span[];
		projectMatched: boolean;
		items: Hit[];
		topScore: number;
	}

	const result = $derived.by<{ groups: Group[]; flat: Hit[] }>(() => {
		const Q = query.trim();
		if (!Q) return { groups: [], flat: [] };
		const flat = flatten(searchTree);

		const projectMatch = new Map<string, Match>();
		for (const { item } of flat) {
			if (item.type === 'project') {
				const m = fuzzy(item.name, Q);
				if (m) projectMatch.set(item.id, m);
			}
		}

		const hits: Hit[] = [];
		const seen = new Set<string>();

		for (const { item, project } of flat) {
			const m = fuzzy(item.name, Q);
			if (m) {
				const bonus = item.type === 'project' ? 200 : 100;
				hits.push({ item, project, score: m.score + bonus, spans: m.spans, via: 'self' });
				seen.add(item.id);
			}
		}

		// Cascade: any project that matched contributes its descendants.
		for (const { item, project } of flat) {
			if (item.type === 'project') continue;
			if (!project || !projectMatch.has(project.id)) continue;
			if (seen.has(item.id)) continue;
			const pm = projectMatch.get(project.id)!;
			hits.push({ item, project, score: pm.score - 80, spans: [], via: 'project' });
			seen.add(item.id);
		}

		// Group by project; root bucket for items with no project.
		const groupMap = new Map<string, Group>();
		for (const h of hits) {
			const key = h.project?.id ?? '__root';
			let g = groupMap.get(key);
			if (!g) {
				const pm = h.project ? projectMatch.get(h.project.id) : undefined;
				g = {
					key,
					project: h.project,
					projectSpans: pm?.spans,
					projectMatched: !!pm,
					items: [],
					topScore: 0
				};
				groupMap.set(key, g);
			}
			g.items.push(h);
			if (h.score > g.topScore) g.topScore = h.score;
		}

		const groups = [...groupMap.values()];
		for (const g of groups) {
			g.items.sort((a, b) => b.score - a.score);
		}
		groups.sort((a, b) => b.topScore - a.topScore);

		// Flat ordered list mirroring render order — used for keyboard navigation.
		const flatHits: Hit[] = [];
		for (const g of groups) {
			for (const h of g.items) flatHits.push(h);
		}
		return { groups, flat: flatHits };
	});

	const totalCount = $derived(result.flat.length);

	function handleKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
			event.preventDefault();
			if (open) closeSearch();
			else openSearch();
			return;
		}
		if (!open) return;
		if (event.key === 'Escape') {
			closeSearch();
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, totalCount - 1);
			scrollSelectedIntoView();
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			scrollSelectedIntoView();
			return;
		}
		if (event.key === 'Enter' && result.flat[selectedIndex]) {
			event.preventDefault();
			handleSelect(result.flat[selectedIndex].item);
			return;
		}
	}

	function scrollSelectedIntoView() {
		queueMicrotask(() => {
			const el = document.querySelector('.quick-search-item.is-selected');
			el?.scrollIntoView({ block: 'nearest' });
		});
	}

	function closeSearch() {
		open = false;
		query = '';
		selectedIndex = 0;
	}

	function handleSelect(item: TreeItem) {
		closeSearch();
		goto(item.href);
	}

	$effect(() => {
		if (totalCount > 0 && selectedIndex >= totalCount) selectedIndex = totalCount - 1;
		if (totalCount === 0 && selectedIndex !== 0) selectedIndex = 0;
	});

	// Reset cursor whenever the query changes.
	$effect(() => {
		query;
		selectedIndex = 0;
	});

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('open-quick-search', openSearch);
		return () => {
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('open-quick-search', openSearch);
		};
	});

	// ── Highlight matched character ranges ──
	function segments(
		name: string,
		spans: Span[] | undefined
	): Array<{ text: string; hit: boolean }> {
		if (!spans || spans.length === 0) return [{ text: name, hit: false }];
		const out: Array<{ text: string; hit: boolean }> = [];
		let cursor = 0;
		for (const [s, e] of spans) {
			if (s > cursor) out.push({ text: name.slice(cursor, s), hit: false });
			out.push({ text: name.slice(s, e), hit: true });
			cursor = e;
		}
		if (cursor < name.length) out.push({ text: name.slice(cursor), hit: false });
		return out;
	}

	// ── Motion ──
	function motionPopover(closing: () => boolean, onClosed: () => void) {
		return motionPopoverBase({
			closing,
			onClosed,
			from: { opacity: 0, scale: 0.96, y: -8 },
			stiffness: 540
		});
	}
	function motionBackdrop(closing: () => boolean) {
		return motionBackdropBase(closing, () => {});
	}
	function rowStagger(index: number) {
		return motionStaggerBase({
			index: Math.min(index, 12),
			stride: 0.018,
			from: { y: 4, opacity: 0, scale: 1 }
		});
	}

	// Drive open/close of the modal with a render-flag pattern so the OUT
	// spring can play before unmount.
	let render = $state(false);
	$effect(() => {
		if (open) render = true;
	});
</script>

{#if render}
	<div
		class="quick-search-overlay"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeSearch();
		}}
		{@attach motionBackdrop(() => !open)}
	>
		<div
			class="quick-search-modal"
			{@attach motionPopover(
				() => !open,
				() => {
					render = false;
				}
			)}
		>
			<div class="quick-search-header">
				<div class="quick-search-input-wrapper">
					<Search class="quick-search-icon" />
					<input
						type="text"
						class="quick-search-input"
						placeholder="Search projects, apps, databases…"
						bind:value={query}
					/>
					{#if query}
						<button
							type="button"
							class="quick-search-clear"
							onclick={() => {
								query = '';
							}}
							aria-label="Clear"
						>
							<X class="h-4 w-4" />
						</button>
					{/if}
				</div>
			</div>

			<div class="quick-search-results">
				{#if !query.trim()}
					<div class="quick-search-empty">
						<p class="quick-search-empty-text">
							Type to search across every project and its contents.
						</p>
						<p class="quick-search-empty-hint">
							Tip: typing a project name reveals everything inside it.
						</p>
					</div>
				{:else if totalCount === 0}
					<div class="quick-search-empty">
						<p class="quick-search-empty-text">No matches for "{query}"</p>
					</div>
				{:else}
					{@const flat = result.flat}
					{#each result.groups as group (group.key)}
						{#if group.project && (group.items.length > 1 || group.items[0].item.id !== group.project.id)}
							<div class="quick-search-group-header">
								<span class="quick-search-group-label">
									{#each segments(group.project.name, group.projectSpans) as seg, si (si)}
										<span class:hl={seg.hit}>{seg.text}</span>
									{/each}
								</span>
								{#if group.projectMatched}
									<span class="quick-search-group-pill">project match</span>
								{/if}
							</div>
						{/if}
						{#each group.items as hit, j (hit.item.id)}
							{@const Icon = getIcon(hit.item.type)}
							{@const flatIndex = flat.indexOf(hit)}
							{@const isSelected = flatIndex === selectedIndex}
							<button
								type="button"
								class="quick-search-item"
								class:is-selected={isSelected}
								class:is-nested={!!group.project && hit.item.id !== group.project.id}
								onclick={() => handleSelect(hit.item)}
								onmouseenter={() => (selectedIndex = flatIndex)}
								{@attach rowStagger(flatIndex)}
							>
								<Icon class="quick-search-item-icon" />
								<div class="quick-search-item-content">
									<div class="quick-search-item-name">
										{#each segments(hit.item.name, hit.spans) as seg, si (si)}
											<span class:hl={seg.hit}>{seg.text}</span>
										{/each}
									</div>
									<div class="quick-search-item-meta">
										<span class="quick-search-item-type">{typeLabel(hit.item.type)}</span>
										{#if hit.via === 'project' && hit.project}
											<span class="quick-search-item-context">in {hit.project.name}</span>
										{/if}
									</div>
								</div>
							</button>
						{/each}
					{/each}
				{/if}
			</div>

			<div class="quick-search-footer">
				<div class="quick-search-hint">
					<span class="quick-search-hint-key">↑↓</span>
					<span class="quick-search-hint-text">Navigate</span>
				</div>
				<div class="quick-search-hint">
					<span class="quick-search-hint-key">↵</span>
					<span class="quick-search-hint-text">Open</span>
				</div>
				<div class="quick-search-hint">
					<span class="quick-search-hint-key">Esc</span>
					<span class="quick-search-hint-text">Close</span>
				</div>
				{#if totalCount > 0}
					<div class="quick-search-count">{totalCount} result{totalCount === 1 ? '' : 's'}</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.quick-search-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background-color: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 10vh;
	}

	.quick-search-modal {
		width: 100%;
		max-width: 36rem;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		box-shadow:
			0 20px 25px -5px rgba(0, 0, 0, 0.1),
			0 10px 10px -5px rgba(0, 0, 0, 0.04);
		overflow: hidden;
		transform-origin: center top;
	}

	:root.dark .quick-search-modal {
		box-shadow:
			0 20px 25px -5px rgba(0, 0, 0, 0.5),
			0 10px 10px -5px rgba(0, 0, 0, 0.3);
	}

	.quick-search-header {
		padding: 1rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.quick-search-input-wrapper {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.quick-search-icon {
		position: absolute;
		left: 0.75rem;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--surface-muted);
		pointer-events: none;
		z-index: 1;
	}

	.quick-search-input {
		width: 100%;
		margin: 0;
		padding: 0.75rem 0.75rem 0.75rem 2.4rem;
		font-size: 0.9375rem;
		background-color: var(--control-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		color: var(--center-channel-color);
		outline: none;
		transition:
			border-color 120ms ease,
			box-shadow 120ms ease;
	}

	.quick-search-input:focus {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 20%, transparent);
	}

	.quick-search-input::placeholder {
		color: var(--surface-muted);
	}

	.quick-search-clear {
		position: absolute;
		right: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		background-color: transparent;
		border: none;
		border-radius: 0.25rem;
		color: var(--surface-muted);
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.quick-search-clear:hover {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
	}

	.quick-search-results {
		flex: 1;
		overflow-y: auto;
		max-height: 26rem;
		padding: 0.5rem;
	}

	.quick-search-group-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem 0.25rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--surface-muted);
	}

	.quick-search-group-label {
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.75rem;
		font-weight: 600;
		color: color-mix(in srgb, var(--center-channel-color) 75%, transparent);
	}

	.quick-search-group-pill {
		display: inline-flex;
		align-items: center;
		padding: 0.0625rem 0.4375rem;
		font-size: 0.625rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sidebar-text-active-border);
		background: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		border-radius: 999px;
	}

	.quick-search-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
		text-align: left;
		background-color: transparent;
		border: none;
		border-radius: 0.5rem;
		color: var(--center-channel-color);
		cursor: pointer;
		transition: background-color 100ms ease;
	}

	.quick-search-item.is-nested {
		padding-left: 1.5rem;
	}

	.quick-search-item.is-selected {
		background-color: var(--dropdown-hover-bg);
	}

	.quick-search-item-icon {
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		color: var(--surface-muted);
	}

	.quick-search-item.is-selected .quick-search-item-icon {
		color: var(--sidebar-text-active-border);
	}

	.quick-search-item-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.quick-search-item-name {
		font-size: 0.9375rem;
		font-weight: 500;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.quick-search-item-name :global(.hl) {
		color: var(--sidebar-text-active-border);
		font-weight: 600;
	}

	.quick-search-group-label :global(.hl) {
		color: var(--sidebar-text-active-border);
	}

	.quick-search-item-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.quick-search-item-type {
		text-transform: capitalize;
	}

	.quick-search-item-context::before {
		content: '·';
		margin-right: 0.5rem;
		opacity: 0.6;
	}

	.quick-search-empty {
		padding: 3rem 1rem;
		text-align: center;
	}

	.quick-search-empty-text {
		font-size: 0.875rem;
		color: var(--center-channel-color);
		margin: 0;
	}

	.quick-search-empty-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.375rem 0 0;
	}

	.quick-search-footer {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.625rem 1rem;
		border-top: 1px solid var(--surface-border);
		background-color: var(--control-bg);
	}

	.quick-search-hint {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.quick-search-hint-key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.5rem;
		height: 1.5rem;
		padding: 0 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.25rem;
		color: var(--center-channel-color);
	}

	.quick-search-hint-text {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.quick-search-count {
		margin-left: auto;
		font-size: 0.75rem;
		color: var(--surface-muted);
	}
</style>
