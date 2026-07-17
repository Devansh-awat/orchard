<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { ArrowLeft, ArrowUp, ImageIcon, MessageSquare, Pin, Plus } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, Modal, Dropdown, StatusBadge, EmptyState, Skeleton } from '$lib/components/ui';
	import { timeAgo, projectSwatch } from '$lib/components/org-dashboard/helpers.svelte';
	import { springHover, motionStagger } from '$lib/utils/motion.svelte';
	import {
		groveStatus,
		grovePriority,
		scopeLabel,
		GROVE_STATUSES,
		GROVE_SCOPES,
		type GroveCategory,
		type GroveThread
	} from '$lib/components/grove/grove';
	import ImageAttach from '$lib/components/grove/ImageAttach.svelte';

	let categories = $state<GroveCategory[]>([]);
	let threads = $state<GroveThread[]>([]);
	let loading = $state(true);
	let activeCat = $state('');
	let statusFilter = $state('');
	let scopeFilter = $state('');
	let sort = $state<'latest' | 'top'>('latest');
	let composerOpen = $state(false);
	let composerCat = $state('bugs');
	let composerScope = $state('platform');
	let composerTitle = $state('');
	let composerBody = $state('');
	let composerImages = $state<string[]>([]);
	let submitting = $state(false);

	async function fetchCategories() {
		const res = await apiFetch('/apiv1/forum/categories');
		if (res.ok) categories = await res.json();
	}

	async function fetchThreads() {
		loading = true;
		const params = new URLSearchParams();
		if (activeCat) params.set('category', activeCat);
		if (statusFilter) params.set('status', statusFilter);
		if (scopeFilter) params.set('scope', scopeFilter);
		if (sort === 'top') params.set('sort', 'top');
		const qs = params.toString();
		const res = await apiFetch(`/apiv1/forum/threads${qs ? `?${qs}` : ''}`);
		if (res.ok) threads = await res.json();
		loading = false;
	}

	function pickCat(slug: string) {
		activeCat = activeCat === slug ? '' : slug;
		fetchThreads();
	}

	function pickSort(s: 'latest' | 'top') {
		if (sort === s) return;
		sort = s;
		fetchThreads();
	}

	async function toggleVote(t: GroveThread, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		const on = !t.myVote;
		t.myVote = on;
		t.votes += on ? 1 : -1;
		const res = await apiFetch(`/apiv1/forum/threads/${t.id}/vote`, {
			method: on ? 'POST' : 'DELETE'
		});
		if (res.ok) {
			const data = await res.json();
			t.votes = data.votes;
			t.myVote = data.myVote;
		} else {
			t.myVote = !on;
			t.votes += on ? -1 : 1;
		}
	}

	async function submitThread() {
		if (submitting) return;
		submitting = true;
		try {
			const res = await apiFetch('/apiv1/forum/threads', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					categorySlug: composerCat,
					scope: composerScope,
					title: composerTitle,
					body: composerBody,
					images: composerImages
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to create post');
			}
			const created = await res.json();
			composerOpen = false;
			composerTitle = '';
			composerBody = '';
			composerImages = [];
			goto(`/grove/${created.id}`);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to create post',
				color: 'error'
			});
		} finally {
			submitting = false;
		}
	}

	onMount(() => {
		fetchCategories();
		fetchThreads();
	});
</script>

<svelte:head><title>The Grove · Orchard</title></svelte:head>

<div class="gv-page">
	<div class="gv-shell">
		<a href="/" class="gv-back"><ArrowLeft class="h-3.5 w-3.5" /> Orchard</a>

		<header class="gv-hero" {@attach motionStagger({ index: 0, from: { y: 10 } })}>
			<div class="gv-hero-text">
				<h1 class="gv-title">The Grove</h1>
			</div>
			<div class="gv-hero-sprites" aria-hidden="true">
				{#each ['pome', 'drupe', 'berry', 'citrus'] as seed (seed)}
					<span class="gv-sprite" style={projectSwatch(seed)}></span>
				{/each}
			</div>
			<Button variant="primary" onclick={() => (composerOpen = true)}>
				<Plus class="h-4 w-4" /> New issue
			</Button>
		</header>

		<nav class="gv-filters" {@attach motionStagger({ index: 1, from: { y: 8 } })}>
			<div class="gv-cats">
				<button
					type="button"
					class="gv-chip"
					class:gv-chip--active={activeCat === ''}
					onclick={() => pickCat('')}
				>
					All
				</button>
				{#each categories as cat (cat.slug)}
					<button
						type="button"
						class="gv-chip"
						class:gv-chip--active={activeCat === cat.slug}
						onclick={() => pickCat(cat.slug)}
					>
						{cat.name}
						{#if cat.threadCount > 0}<span class="gv-chip-count">{cat.threadCount}</span>{/if}
					</button>
				{/each}
			</div>
			<Dropdown
				bind:value={scopeFilter}
				class="gv-filter-dd{scopeFilter ? ' gv-filter-dd--set' : ''}"
				options={[
					{ value: '', label: 'All scopes' },
					...GROVE_SCOPES.map((s) => ({ value: s.value, label: s.label }))
				]}
				onchange={fetchThreads}
			/>
			<Dropdown
				bind:value={statusFilter}
				class="gv-filter-dd{statusFilter ? ' gv-filter-dd--set' : ''}"
				options={[
					{ value: '', label: 'All statuses' },
					...GROVE_STATUSES.map((s) => ({ value: s, label: groveStatus(s).label }))
				]}
				onchange={fetchThreads}
			/>
			<div class="gv-sort" role="radiogroup" aria-label="Sort">
				<button
					type="button"
					role="radio"
					aria-checked={sort === 'latest'}
					class="gv-sort-btn"
					class:gv-sort-btn--active={sort === 'latest'}
					onclick={() => pickSort('latest')}
				>
					Latest
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={sort === 'top'}
					class="gv-sort-btn"
					class:gv-sort-btn--active={sort === 'top'}
					onclick={() => pickSort('top')}
				>
					Top
				</button>
			</div>
		</nav>

		{#if loading}
			<div class="gv-grid">
				{#each Array(6) as _, i (i)}
					<Skeleton height="9rem" />
				{/each}
			</div>
		{:else if threads.length === 0}
			<EmptyState title="No issues yet">
				<Button variant="primary" onclick={() => (composerOpen = true)}>
					<Plus class="h-4 w-4" /> New issue
				</Button>
			</EmptyState>
		{:else}
			<div class="gv-grid">
				{#each threads as t, i (t.id)}
					<a
						href="/grove/{t.id}"
						class="gv-card"
						{@attach motionStagger({ index: i, from: { y: 10 } })}
						{@attach springHover({ lift: -2, stiffness: 360, damping: 22 })}
					>
						<div class="gv-card-top">
							<span class="gv-num">#{t.number}</span>
							<span class="gv-cat-tag">{t.category.name}</span>
							<span class="gv-cat-tag">{scopeLabel(t.scope)}</span>
							{#if grovePriority(t.priority)}
								<StatusBadge meta={grovePriority(t.priority)!} />
							{/if}
							<StatusBadge meta={groveStatus(t.status)} />
							{#if t.pinned}<span class="gv-pin"><Pin size={12} /></span>{/if}
						</div>
						<h2 class="gv-card-title">{t.title}</h2>
						<p class="gv-card-snippet">{t.snippet}</p>
						<div class="gv-card-foot">
							{#if t.author.imageUrl}
								<img src={t.author.imageUrl} alt="" class="gv-av" loading="lazy" decoding="async" />
							{:else}
								<span class="gv-av" style={projectSwatch(t.author.username)}></span>
							{/if}
							<span class="gv-author">{t.author.username}</span>
							<span class="gv-when">{timeAgo(t.lastActivityAt)}</span>
							{#if t.images.length > 0}
								<span class="gv-replies"><ImageIcon size={12} /> {t.images.length}</span>
							{/if}
							<span class="gv-replies"><MessageSquare size={12} /> {t.replyCount}</span>
							<button
								type="button"
								class="gv-vote"
								class:gv-vote--on={t.myVote}
								aria-pressed={t.myVote}
								aria-label="Upvote"
								onclick={(e) => toggleVote(t, e)}
							>
								<ArrowUp size={12} />
								{t.votes}
							</button>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</div>

<Modal bind:open={composerOpen} title="New issue" size="md">
	<div class="gv-form">
		<div class="gv-type-row" role="radiogroup" aria-label="Type">
			{#each categories as cat (cat.slug)}
				<button
					type="button"
					role="radio"
					aria-checked={composerCat === cat.slug}
					class="gv-type-card"
					class:gv-type-card--active={composerCat === cat.slug}
					onclick={() => (composerCat = cat.slug)}
				>
					<span class="gv-type-name">{cat.name}</span>
				</button>
			{/each}
		</div>
		<div class="gv-scope-row" role="radiogroup" aria-label="Scope">
			{#each GROVE_SCOPES as s (s.value)}
				<button
					type="button"
					role="radio"
					aria-checked={composerScope === s.value}
					class="gv-chip"
					class:gv-chip--active={composerScope === s.value}
					onclick={() => (composerScope = s.value)}
				>
					{s.label}
				</button>
			{/each}
		</div>
		<input
			class="gv-title-input"
			name="grove-post-title"
			aria-label="Title"
			bind:value={composerTitle}
			maxlength={200}
			placeholder="Title"
		/>
		<textarea
			class="gv-textarea"
			name="grove-post-body"
			aria-label="Details"
			bind:value={composerBody}
			rows="6"
			maxlength={10000}
			placeholder="Details"
		></textarea>
		<div class="gv-form-actions">
			<ImageAttach bind:images={composerImages} disabled={submitting} />
			<div class="gv-form-buttons">
				<Button variant="ghost" onclick={() => (composerOpen = false)}>Cancel</Button>
				<Button
					variant="primary"
					disabled={composerTitle.trim().length < 4 || composerBody.trim().length < 1}
					loading={submitting}
					onclick={submitThread}
				>
					Create
				</Button>
			</div>
		</div>
	</div>
</Modal>

<style>
	.gv-page {
		min-height: 100vh;
		background: var(--bg-app);
	}

	.gv-shell {
		max-width: 64rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	.gv-back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--text-muted);
		text-decoration: none;
		margin-bottom: 1.25rem;
	}

	.gv-back:hover {
		color: var(--text-default);
	}

	.gv-hero {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}

	.gv-hero-text {
		min-width: 0;
	}

	.gv-title {
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--text-default);
	}

	.gv-hero-sprites {
		display: flex;
		gap: 0.375rem;
		margin-left: auto;
		margin-right: 0.5rem;
	}

	.gv-sprite {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		border: 1px solid var(--border-default);
	}

	.gv-filters {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 1.25rem;
	}

	.gv-cats {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
		min-width: 0;
	}

	.gv-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.75rem;
		border-radius: 999px;
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 550;
		cursor: pointer;
		transition:
			color 120ms ease,
			background-color 120ms ease,
			border-color 120ms ease;
	}

	.gv-chip:hover {
		color: var(--text-default);
		border-color: var(--border-strong);
	}

	.gv-chip--active {
		background: var(--accent-subtle);
		border-color: var(--accent);
		color: var(--text-default);
	}

	.gv-chip-count {
		font-size: 0.6875rem;
		color: var(--text-faint);
	}

	:global(.ui-dropdown-trigger.gv-filter-dd) {
		width: auto;
		min-width: 0;
		padding: 0.3125rem 0.625rem 0.3125rem 0.75rem;
		border-radius: 999px;
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 550;
		line-height: 1.2;
		gap: 0.25rem;
	}

	:global(.ui-dropdown-trigger.gv-filter-dd:hover) {
		color: var(--text-default);
		border-color: var(--border-strong);
	}

	:global(.ui-dropdown-trigger.gv-filter-dd--set) {
		background: var(--accent-subtle);
		border-color: var(--accent);
		color: var(--text-default);
	}

	.gv-sort {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.1875rem;
		border-radius: 0.625rem;
		background: var(--bg-sunken);
		border: 1px solid var(--border-default);
		margin-left: auto;
	}

	.gv-sort-btn {
		border: none;
		background: none;
		padding: 0.25rem 0.625rem;
		border-radius: 0.4375rem;
		font-size: 0.75rem;
		font-weight: 550;
		color: var(--text-muted);
		cursor: pointer;
	}

	.gv-sort-btn--active {
		background: var(--bg-surface);
		color: var(--text-default);
	}

	.gv-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
		gap: 0.875rem;
	}

	.gv-card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: 0.75rem;
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		text-decoration: none;
		color: var(--text-default);
	}

	.gv-card-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.gv-num {
		font-family: 'Space Mono', monospace;
		font-size: 0.6875rem;
		color: var(--text-faint);
	}

	.gv-cat-tag {
		font-size: 0.6875rem;
		font-weight: 550;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: 999px;
		padding: 0.125rem 0.5rem;
	}

	.gv-pin {
		color: var(--accent);
		display: inline-flex;
		margin-left: auto;
	}

	.gv-card-title {
		font-size: 0.9375rem;
		font-weight: 650;
		line-height: 1.3;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.gv-card-snippet {
		font-size: 0.8125rem;
		color: var(--text-muted);
		line-height: 1.45;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.gv-card-foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: auto;
		padding-top: 0.25rem;
	}

	.gv-av {
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 999px;
		flex-shrink: 0;
		object-fit: cover;
		display: inline-block;
	}

	.gv-author {
		font-size: 0.75rem;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.gv-when {
		font-size: 0.6875rem;
		color: var(--text-faint);
		white-space: nowrap;
	}

	.gv-replies {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-left: auto;
	}

	.gv-vote {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.1875rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			color 120ms ease,
			background-color 120ms ease,
			border-color 120ms ease;
	}

	.gv-vote:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.gv-vote--on {
		background: var(--accent-subtle);
		border-color: var(--accent);
		color: var(--accent);
	}

	.gv-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.gv-type-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}

	@media (max-width: 480px) {
		.gv-type-row {
			grid-template-columns: 1fr;
		}
	}

	.gv-type-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.125rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		cursor: pointer;
		text-align: left;
		transition:
			border-color 120ms ease,
			background-color 120ms ease;
	}

	.gv-type-card:hover {
		border-color: var(--border-strong);
	}

	.gv-type-card--active {
		border-color: var(--accent);
		background: var(--accent-subtle);
	}

	.gv-type-name {
		font-size: 0.8125rem;
		font-weight: 650;
		color: var(--text-default);
	}

	.gv-scope-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.gv-title-input {
		width: 100%;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--bg-surface);
		color: var(--text-default);
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.4;
		padding: 0.625rem 0.75rem;
	}

	.gv-title-input::placeholder {
		color: var(--text-faint);
		font-weight: 500;
	}

	.gv-title-input:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -1px;
	}

	.gv-form-buttons {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.gv-textarea {
		width: 100%;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--bg-surface);
		color: var(--text-default);
		font-size: 0.875rem;
		line-height: 1.5;
		padding: 0.625rem 0.75rem;
		resize: vertical;
	}

	.gv-textarea:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -1px;
	}

	.gv-form-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	@media (max-width: 640px) {
		.gv-hero {
			flex-wrap: wrap;
		}

		.gv-hero-sprites {
			display: none;
		}
	}
</style>
