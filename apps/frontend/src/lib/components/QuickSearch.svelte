<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { createQuery } from '@tanstack/svelte-query';
	import { selectedOrganization, apiFetch, toasts } from '$lib/stores';
	import { registerShortcut } from '$lib/utils/shortcuts';
	import { overviewQueryOptions, userOverviewQueryOptions } from '$lib/queries/overview';
	import {
		Search,
		CornerDownLeft,
		Database,
		LayoutTemplate,
		X,
		Command,
		Clock
	} from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { IconTile } from '$lib/components/ui';
	import { avatarUrl } from '$lib/avatar';
	import {
		knownIcon,
		favUrl,
		iconTint,
		projectSwatch,
		IMG_ICONS
	} from './org-dashboard/helpers.svelte';
	import {
		actionsFor,
		foreignResults,
		mergeResults,
		rankedResults,
		recentItems,
		recordUse,
		segments,
		type Action,
		type Frecency,
		type Group,
		type Hit,
		type Person,
		type TreeItem
	} from './quick-search';
	import {
		motionPopover as motionPopoverBase,
		motionBackdrop as motionBackdropBase,
		motionStagger as motionStaggerBase,
		magneticHighlight
	} from '$lib/utils/motion.svelte';

	let open = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);
	let panelOpen = $state(false);
	let actionIndex = $state(0);
	let busy = $state(false);

	const FRECENCY_KEY = 'quick-search-frecency';
	function loadFrecency(): Frecency {
		if (typeof localStorage === 'undefined') return {};
		try {
			return JSON.parse(localStorage.getItem(FRECENCY_KEY) ?? '{}') as Frecency;
		} catch {
			return {};
		}
	}
	let frecency = $state<Frecency>(loadFrecency());
	function touch(id: string) {
		frecency = recordUse(frecency, id, Date.now());
		try {
			localStorage.setItem(FRECENCY_KEY, JSON.stringify(frecency));
		} catch {
			/* storage full or blocked: frecency is a convenience */
		}
	}

	const orgSlug = $derived($page.params.orgSlug ?? $selectedOrganization?.slug);

	const overview = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: open && !!orgSlug
	}));

	const crossOrg = $derived(open && query.trim().length >= 2);
	const everything = createQuery(() => ({
		...userOverviewQueryOptions(),
		enabled: crossOrg,
		staleTime: 60_000
	}));

	type ProjectRef = { id: string; name: string; slug: string };
	type CreatorRef = {
		id: string;
		username?: string | null;
		firstName?: string | null;
		lastName?: string | null;
		imageUrl?: string | null;
	};
	type OverviewLite = {
		deployments?: Array<{
			id: string;
			name: string;
			displayName?: string | null;
			image?: string;
			faviconUrl?: string | null;
			ingresses?: Array<{ host: string }>;
			project?: ProjectRef;
			creator?: CreatorRef | null;
		}>;
		databases?: Array<{
			id: string;
			name: string;
			project?: ProjectRef;
			creator?: CreatorRef | null;
		}>;
		projects?: ProjectRef[];
	};

	function toPerson(c: CreatorRef | null | undefined): Person | undefined {
		if (!c) return undefined;
		const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
		const name = full || c.username || '';
		if (!name) return undefined;
		return { id: c.id, name, username: c.username ?? undefined, imageUrl: c.imageUrl };
	}

	function buildTree(data: OverviewLite, slug: string, orgName?: string): TreeItem[] {
		const projects = new Map<string, TreeItem>();
		const ensureProject = (p: ProjectRef) => {
			let node = projects.get(p.id);
			if (!node) {
				node = {
					id: p.id,
					name: p.name,
					type: 'project',
					href: `/${slug}/projects/${p.slug}`,
					slug: p.slug,
					orgName,
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
				name: d.displayName || d.name,
				type: 'deployment',
				href: `/${slug}/deployments/${d.id}`,
				image: d.image,
				faviconUrl: d.faviconUrl,
				ingressHost: d.ingresses?.[0]?.host.split('/')[0],
				owner: toPerson(d.creator),
				orgName
			});
		}
		for (const db of data.databases ?? []) {
			if (!db.project) continue;
			ensureProject(db.project).children!.push({
				id: db.id,
				name: db.name,
				type: 'database',
				href: `/${slug}/databases/${db.id}`,
				owner: toPerson(db.creator),
				orgName
			});
		}
		for (const p of data.projects ?? []) ensureProject(p);
		return [...projects.values()];
	}

	type UserOverview = OverviewLite & {
		organizations?: Array<{ id: string; slug: string; name: string }>;
		projects?: Array<ProjectRef & { organizationId?: string }>;
	};

	const foreignTree = $derived.by<TreeItem[]>(() => {
		const data = everything.data as UserOverview | undefined;
		if (!data || !crossOrg) return [];
		const current = $selectedOrganization?.id;
		const out: TreeItem[] = [];
		for (const org of data.organizations ?? []) {
			if (org.id === current || org.slug === orgSlug) continue;
			const slice: OverviewLite = {
				projects: (data.projects ?? []).filter((p) => p.organizationId === org.id),
				deployments: (data.deployments ?? []).filter(
					(d) => (d.project as ProjectRef & { organizationId?: string })?.organizationId === org.id
				),
				databases: (data.databases ?? []).filter(
					(d) => (d.project as ProjectRef & { organizationId?: string })?.organizationId === org.id
				)
			};
			out.push({
				id: `org:${org.id}`,
				name: org.name,
				type: 'organization',
				href: `/${org.slug}`,
				slug: org.slug,
				children: buildTree(slice, org.slug, org.name)
			});
		}
		return out;
	});

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
					slug: p.slug,
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
				name: d.displayName || d.name,
				type: 'deployment',
				href: `/${orgSlug}/deployments/${d.id}`,
				image: d.image,
				faviconUrl: d.faviconUrl,
				ingressHost: d.ingresses?.[0]?.host.split('/')[0],
				owner: toPerson(d.creator)
			});
		}
		for (const db of data.databases ?? []) {
			if (!db.project) continue;
			ensureProject(db.project).children!.push({
				id: db.id,
				name: db.name,
				type: 'database',
				href: `/${orgSlug}/databases/${db.id}`,
				owner: toPerson(db.creator)
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

	function typeLabel(type: TreeItem['type']) {
		switch (type) {
			case 'organization':
				return 'org';
			case 'templateInstance':
				return 'template';
			case 'deployment':
				return 'app';
			default:
				return type;
		}
	}

	const result = $derived.by<{ groups: Group[]; flat: Hit[] }>(() => {
		if (query.trim()) {
			const home = rankedResults(searchTree, query, frecency, Date.now());
			if (!crossOrg || foreignTree.length === 0) return home;
			return mergeResults(home, foreignResults(foreignTree, query));
		}
		const recent = recentItems(searchTree, frecency, Date.now());
		if (recent.length === 0) return { groups: [], flat: [] };
		const items: Hit[] = recent.map((item) => ({ item, score: 0, spans: [], via: 'self' }));
		return {
			groups: [{ key: '__recent', projectMatched: false, items, topScore: 0 }],
			flat: items
		};
	});

	const selectedHit = $derived(result.flat[selectedIndex] ?? null);
	const actions = $derived(selectedHit ? actionsFor(selectedHit.item) : []);

	const totalCount = $derived(result.flat.length);

	function togglePanel() {
		if (!selectedHit) return;
		panelOpen = !panelOpen;
		actionIndex = 0;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (panelOpen) {
			if (event.key === 'Escape') {
				event.preventDefault();
				panelOpen = false;
				return;
			}
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				actionIndex = Math.min(actionIndex + 1, actions.length - 1);
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				actionIndex = Math.max(actionIndex - 1, 0);
				return;
			}
			if (event.key === 'Enter' && selectedHit && actions[actionIndex]) {
				event.preventDefault();
				void runAction(selectedHit, actions[actionIndex]);
				return;
			}
			if (!event.metaKey && !event.ctrlKey && event.key.length === 1 && selectedHit) {
				const hit = actions.find((a) => a.key?.toLowerCase() === event.key.toLowerCase());
				if (hit) {
					event.preventDefault();
					void runAction(selectedHit, hit);
				}
			}
			return;
		}
		if (event.key === 'Escape') {
			closeSearch();
			return;
		}
		if ((event.key === 'ArrowRight' || event.key === 'Tab') && selectedHit) {
			event.preventDefault();
			togglePanel();
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
		panelOpen = false;
		query = '';
		selectedIndex = 0;
	}

	function handleSelect(item: TreeItem) {
		touch(item.id);
		closeSearch();
		goto(item.href);
	}

	async function runAction(hit: Hit, action: Action) {
		const { item } = hit;
		if (busy) return;
		touch(item.id);
		if (action.kind === 'navigate' && action.href) {
			closeSearch();
			await goto(action.href);
			return;
		}
		if (action.kind === 'open' && action.href) {
			closeSearch();
			window.open(action.href, '_blank', 'noopener');
			return;
		}
		busy = true;
		try {
			if (action.kind === 'copy') {
				let text = '';
				if (action.copyField === 'url' && item.ingressHost) text = `https://${item.ingressHost}`;
				if (action.copyField === 'connectionString') {
					const res = await apiFetch(`/apiv1/databases/${item.id}/connection`);
					if (!res.ok) throw new Error('Could not load the database credentials');
					const data = await res.json();
					text = data.connectionString ?? '';
				}
				if (!text) throw new Error('Nothing to copy');
				await navigator.clipboard.writeText(text);
				toasts.add({ title: 'Copied', color: 'success' });
			} else if (action.kind === 'call' && action.path) {
				const res = await apiFetch(action.path, { method: action.method ?? 'POST' });
				if (!res.ok) {
					const data = await res.json().catch(() => null);
					throw new Error(data?.message || `${action.label} failed`);
				}
				toasts.add({ title: `${action.label}: ${item.name}`, color: 'success' });
			}
			closeSearch();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : `${action.label} failed`,
				color: 'error'
			});
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		if (totalCount > 0 && selectedIndex >= totalCount) selectedIndex = totalCount - 1;
		if (totalCount === 0 && selectedIndex !== 0) selectedIndex = 0;
	});

	// Reset cursor whenever the query changes.
	$effect(() => {
		query;
		selectedIndex = 0;
		panelOpen = false;
	});

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('open-quick-search', openSearch);
		const unregister = registerShortcut({
			id: 'palette',
			key: 'k',
			mod: true,
			label: 'Search and actions',
			allowInInputs: true,
			run: () => {
				if (!open) openSearch();
				else if (selectedHit) togglePanel();
				else closeSearch();
			}
		});
		return () => {
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('open-quick-search', openSearch);
			unregister();
		};
	});

	// ── Motion ──
	function motionPopover(closing: () => boolean, onClosed: () => void) {
		return motionPopoverBase({
			closing,
			onClosed,
			from: { opacity: 0, scale: 0.96, y: -8 }
		});
	}
	function motionBackdrop(closing: () => boolean) {
		return motionBackdropBase(closing, () => {});
	}
	function rowStagger(index: number) {
		return motionStaggerBase({
			index: Math.min(index, 12),
			from: { y: 4, opacity: 0, scale: 1 }
		});
	}

	// Drive open/close of the modal with a render-flag pattern so the OUT
	// spring can play before unmount.
	let render = $state(false);
	$effect(() => {
		if (open) render = true;
	});

	// The selection is one pill that springs between rows (iOS-pointer style)
	// rather than each row swapping its own background. Track the live selected
	// element so `magneticHighlight` can chase it.
	let selectedEl = $state<HTMLElement | null>(null);
	$effect(() => {
		selectedIndex;
		result.flat.length;
		// Clear synchronously when there is nothing to point at, so the cursor
		// disappears the instant the query is emptied instead of lingering.
		if (!open || totalCount === 0) {
			selectedEl = null;
			return;
		}
		queueMicrotask(() => {
			if (!open) return;
			selectedEl = document.querySelector<HTMLElement>('.quick-search-item.is-selected');
		});
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
			{#snippet itemVisual(item: TreeItem)}
				{#if item.type === 'organization'}
					<span class="qs-ic qs-ic--letter" style={projectSwatch(item.slug ?? item.id)}>
						<span class="qs-ic-letter">{item.name.charAt(0).toUpperCase()}</span>
					</span>
				{:else if item.type === 'project'}
					<span class="qs-ic qs-ic--swatch" style={projectSwatch(item.slug ?? item.id)}></span>
				{:else if item.type === 'deployment'}
					{@const known = knownIcon(item.image)}
					{@const src =
						known ?? item.faviconUrl ?? (item.ingressHost ? favUrl(item.ingressHost) : null)}
					<IconTile class="qs-ic" {src} tint={!known && src ? iconTint(item.id) : undefined}>
						{#snippet fallback()}
							<span class="qs-ic-letter">{item.name.charAt(0).toUpperCase()}</span>
						{/snippet}
					</IconTile>
				{:else if item.type === 'database'}
					<IconTile class="qs-ic qs-ic--logo" src={IMG_ICONS.postgres}>
						{#snippet fallback()}
							<Database size={15} />
						{/snippet}
					</IconTile>
				{:else}
					<span class="qs-ic qs-ic--glyph"><LayoutTemplate size={15} /></span>
				{/if}
			{/snippet}

			<div class="quick-search-header">
				<Search class="quick-search-icon" />
				<input
					type="text"
					class="quick-search-input"
					placeholder="Search projects, apps, databases and people"
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
						<X size={14} />
					</button>
				{:else}
					<kbd class="qs-kbd">esc</kbd>
				{/if}
			</div>

			<div class="quick-search-results" class:has-panel={panelOpen}>
				<div class="quick-search-list">
					<div class="qs-pill" {@attach magneticHighlight(() => selectedEl)}>
						<CornerDownLeft class="qs-pill-enter" size={14} />
					</div>
					{#if !query.trim() && totalCount === 0}
						<div class="quick-search-empty">
							<span class="quick-search-empty-glyph"><Search size={18} /></span>
							<p class="quick-search-empty-text">Search everything in this org</p>
						</div>
					{:else if totalCount === 0}
						<div class="quick-search-empty">
							<p class="quick-search-empty-text">No matches for “{query}”</p>
						</div>
					{:else}
						{@const flat = result.flat}
						{#each result.groups as group, gi (group.key)}
							{#if group.foreign && !result.groups[gi - 1]?.foreign}
								<div class="quick-search-divider">
									<span>In other organizations</span>
								</div>
							{/if}
							{#if group.person}
								<div class="quick-search-group-header">
									<img class="qs-person-avatar" src={avatarUrl(group.person)} alt="" />
									<span class="quick-search-group-label">
										{#each segments(group.person.name, group.personField === 'name' ? group.personSpans : undefined) as seg, si (si)}
											<span class:hl={seg.hit}>{seg.text}</span>
										{/each}
									</span>
									{#if group.person.username}
										<span class="quick-search-group-handle">
											{#each segments(`@${group.person.username}`, group.personField === 'username' ? group.personSpans : undefined, 1) as seg, si (si)}
												<span class:hl={seg.hit}>{seg.text}</span>
											{/each}
										</span>
									{/if}
									<span class="quick-search-group-pill">person</span>
								</div>
							{:else if group.key === '__recent'}
								<div class="quick-search-group-header">
									<Clock size={12} class="qs-recent-glyph" />
									<span class="quick-search-group-label">Recent</span>
								</div>
							{:else if group.project && (group.items.length > 1 || group.items[0].item.id !== group.project.id)}
								<div class="quick-search-group-header">
									<span class="quick-search-group-label">
										{#if group.foreign && group.project.orgName}
											<span class="quick-search-group-org">{group.project.orgName} /</span>
										{/if}
										{#each segments(group.project.name, group.projectSpans) as seg, si (si)}
											<span class:hl={seg.hit}>{seg.text}</span>
										{/each}
									</span>
									{#if group.projectMatched}
										<span class="quick-search-group-pill">project</span>
									{/if}
								</div>
							{/if}
							{#each group.items as hit (hit.item.id)}
								{@const flatIndex = flat.indexOf(hit)}
								{@const isSelected = flatIndex === selectedIndex}
								<button
									type="button"
									class="quick-search-item"
									class:is-selected={isSelected}
									class:is-nested={!!group.person ||
										(!!group.project && hit.item.id !== group.project.id)}
									onclick={() => handleSelect(hit.item)}
									onmouseenter={(e) => {
										selectedIndex = flatIndex;
										selectedEl = e.currentTarget;
									}}
									{@attach rowStagger(flatIndex)}
								>
									{@render itemVisual(hit.item)}
									<div class="quick-search-item-content">
										<div class="quick-search-item-name">
											{#each segments(hit.item.name, hit.spans) as seg, si (si)}
												<span class:hl={seg.hit}>{seg.text}</span>
											{/each}
										</div>
										{#if hit.via !== 'self' && hit.project}
											<div class="quick-search-item-sub">in {hit.project.name}</div>
										{:else if group.foreign && hit.item.type !== 'organization' && hit.item.orgName && hit.item.id === group.project?.id}
											<div class="quick-search-item-sub">in {hit.item.orgName}</div>
										{/if}
									</div>
									<span class="quick-search-item-tag">{typeLabel(hit.item.type)}</span>
								</button>
							{/each}
						{/each}
					{/if}
				</div>
			</div>

			{#if panelOpen && selectedHit}
				<div class="qs-actions" role="menu" aria-label="Actions for {selectedHit.item.name}">
					<div class="qs-actions-head">
						{@render itemVisual(selectedHit.item)}
						<span class="qs-actions-name">{selectedHit.item.name}</span>
					</div>
					{#each actions as action, ai (action.id)}
						<button
							type="button"
							role="menuitem"
							class="qs-action"
							class:is-selected={ai === actionIndex}
							class:is-danger={action.danger}
							disabled={busy}
							onclick={() => runAction(selectedHit, action)}
							onmouseenter={() => (actionIndex = ai)}
						>
							<span class="qs-action-label">{action.label}</span>
							{#if action.key}<kbd class="qs-kbd">{action.key}</kbd>{/if}
						</button>
					{/each}
				</div>
			{/if}

			<div class="quick-search-footer">
				<div class="quick-search-hint">
					<kbd class="qs-kbd">↑</kbd><kbd class="qs-kbd">↓</kbd>
					<span class="quick-search-hint-text">navigate</span>
				</div>
				<div class="quick-search-hint">
					<kbd class="qs-kbd"><CornerDownLeft size={11} /></kbd>
					<span class="quick-search-hint-text">open</span>
				</div>
				{#if selectedHit}
					<button type="button" class="quick-search-hint qs-hint-btn" onclick={togglePanel}>
						<kbd class="qs-kbd"><Command size={10} />K</kbd>
						<span class="quick-search-hint-text">actions</span>
					</button>
				{/if}
				{#if totalCount > 0}
					<div class="quick-search-count">
						{totalCount} result{totalCount === 1 ? '' : 's'}
					</div>
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
		background: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(6px) saturate(120%);
		-webkit-backdrop-filter: blur(6px) saturate(120%);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 12vh 1rem 1rem;
	}

	.quick-search-modal {
		width: 100%;
		max-width: 40rem;
		max-height: 76vh;
		display: flex;
		flex-direction: column;
		background: var(--bg-raised);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xl);
		box-shadow:
			var(--elev-4),
			inset 0 1px 0 0 rgba(255, 255, 255, 0.06);
		overflow: hidden;
		transform-origin: center top;
	}

	.quick-search-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 1rem;
		border-bottom: 1px solid var(--rule);
	}

	.quick-search-icon {
		width: 1.15rem;
		height: 1.15rem;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.quick-search-input {
		flex: 1;
		min-width: 0;
		margin: 0;
		padding: 0;
		background: none;
		border: none;
		outline: none;
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		letter-spacing: var(--track-headline);
		color: var(--text-default);
	}

	.quick-search-input::placeholder {
		color: var(--text-faint);
	}

	.quick-search-clear {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		flex-shrink: 0;
		background: none;
		border: none;
		border-radius: var(--radius-xs);
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.quick-search-clear:hover {
		background: var(--fill-soft);
		color: var(--text-default);
	}

	.qs-kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.3125rem;
		font-family: inherit;
		font-size: var(--text-micro);
		font-weight: 600;
		line-height: 1;
		color: var(--text-muted);
		background: var(--fill-soft);
		border: 1px solid var(--rule);
		border-radius: var(--radius-xs);
	}

	.quick-search-results {
		flex: 1;
		overflow-y: auto;
		max-height: 24rem;
		padding: 0.375rem;
	}

	.quick-search-list {
		position: relative;
	}

	.qs-pill {
		position: absolute;
		left: 0;
		top: 0;
		z-index: 2;
		border-radius: var(--radius-md);
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--border-strong);
		pointer-events: none;
	}

	.qs-pill :global(.qs-pill-enter) {
		position: absolute;
		right: 0.625rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-muted);
	}

	.quick-search-group-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.625rem 0.25rem;
	}

	.quick-search-group-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-faint);
	}

	.quick-search-group-label :global(.hl) {
		color: var(--accent);
	}

	.qs-person-avatar {
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		border-radius: var(--radius-pill);
		object-fit: cover;
		box-shadow: inset 0 0 0 1px var(--rule);
	}

	.quick-search-group-handle {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text-faint);
	}

	.quick-search-group-handle :global(.hl) {
		color: var(--accent);
	}

	.quick-search-group-pill {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
		background: var(--accent-subtle);
		padding: 0.0625rem 0.375rem;
		border-radius: var(--radius-pill);
	}

	.quick-search-item {
		position: relative;
		z-index: 1;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.4375rem 0.625rem;
		text-align: left;
		background: none;
		border: none;
		border-radius: var(--radius-md);
		color: var(--text-default);
		cursor: pointer;
	}

	.quick-search-item.is-nested {
		padding-left: 1.625rem;
	}

	.quick-search-list :global(.qs-ic) {
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		background: var(--fill-soft);
		box-shadow: inset 0 0 0 1px var(--rule);
	}

	.quick-search-list :global(.qs-ic--glyph) {
		display: grid;
		place-items: center;
		color: var(--text-muted);
	}

	.quick-search-list :global(.qs-ic--logo) {
		padding: 0.2rem;
		background: color-mix(in srgb, var(--ink) 6%, transparent);
	}
	.quick-search-list :global(.qs-ic--logo .icon-tile-img) {
		object-fit: contain;
	}

	.quick-search-list :global(.qs-ic-letter) {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		font-size: var(--text-caption);
		font-weight: 700;
		color: var(--accent);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 16%, transparent),
			color-mix(in srgb, var(--accent) 4%, transparent)
		);
	}

	.quick-search-item-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
	}

	.quick-search-item-name {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 550;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.quick-search-item-name :global(.hl) {
		color: var(--accent);
		font-weight: 700;
	}

	.quick-search-item-sub {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.quick-search-item-tag {
		flex-shrink: 0;
		margin-left: auto;
		font-size: var(--text-micro);
		line-height: 1;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		transition: opacity var(--dur-fast) ease;
	}

	/* The single travelling enter glyph rides the cursor to this row's right
	   edge, so the row's own tag steps aside for it. */
	.quick-search-item.is-selected .quick-search-item-tag {
		opacity: 0;
	}

	.quick-search-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.375rem;
		padding: 2.75rem 1rem;
		text-align: center;
	}

	.quick-search-empty-glyph {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		margin-bottom: 0.25rem;
		border-radius: var(--radius-md);
		background: var(--fill-soft);
		color: var(--text-faint);
	}

	.quick-search-empty-text {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
	}

	.quick-search-empty-hint {
		margin: 0;
		max-width: 22rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.quick-search-footer {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.5625rem 0.875rem;
		border-top: 1px solid var(--rule);
		background: var(--bg-sunken);
	}

	.quick-search-hint {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.quick-search-hint-text {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.quick-search-count {
		margin-left: auto;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.quick-search-results.has-panel {
		min-height: 20rem;
	}

	.qs-actions {
		position: absolute;
		right: 0.75rem;
		bottom: 3rem;
		max-height: calc(100% - 4rem);
		overflow-y: auto;
		z-index: 3;
		width: 16rem;
		padding: 0.375rem;
		background: var(--bg-raised);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		box-shadow: var(--elev-3);
	}

	.qs-actions-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.5rem 0.5rem;
		border-bottom: 1px solid var(--rule);
		margin-bottom: 0.25rem;
	}

	.qs-actions-head :global(.qs-ic) {
		width: 1.125rem;
		height: 1.125rem;
	}

	.qs-actions-name {
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.qs-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border: none;
		background: none;
		border-radius: var(--radius-sm);
		color: var(--text-default);
		font-size: var(--text-footnote);
		text-align: left;
		cursor: pointer;
	}

	.qs-action.is-selected {
		background: var(--fill-soft);
	}

	.qs-action.is-danger {
		color: var(--status-error);
	}

	.qs-hint-btn {
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: inherit;
	}

	.quick-search-modal {
		position: relative;
	}

	.quick-search-divider {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem 0.25rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.quick-search-divider::before,
	.quick-search-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: color-mix(in srgb, var(--surface-border) 70%, transparent);
	}
	.quick-search-group-org {
		color: var(--text-muted);
		font-weight: 500;
		margin-right: 0.25rem;
	}
	.quick-search-list :global(.qs-ic--letter) {
		display: grid;
		place-items: center;
	}
</style>
