<script module lang="ts">
	import { apiFetch } from '$lib/stores';

	export interface GitHubRepoListing {
		linked: boolean | null;
		repositories: Array<{ id: number; full_name: string; private: boolean }>;
		error: string | null;
	}

	const REPO_CACHE_MS = 5 * 60_000;
	const LOAD_ERROR = 'Could not load your repositories.';
	let repoCache: { at: number; listing: Promise<GitHubRepoListing> } | null = null;

	export function loadGitHubRepos(): Promise<GitHubRepoListing> {
		if (repoCache && Date.now() - repoCache.at < REPO_CACHE_MS) return repoCache.listing;
		const listing = fetchGitHubRepos();
		const entry = { at: Date.now(), listing };
		repoCache = entry;
		void listing.then((result) => {
			if (result.error && repoCache === entry) repoCache = null;
		});
		return listing;
	}

	async function fetchGitHubRepos(): Promise<GitHubRepoListing> {
		try {
			const [statusRes, reposRes] = await Promise.all([
				apiFetch('/apiv1/github/status'),
				apiFetch('/apiv1/github/repositories')
			]);
			const status = statusRes.ok ? await statusRes.json() : null;
			const linked = status ? !!status.linked : null;
			if (linked === false) return { linked, repositories: [], error: null };
			if (!reposRes.ok) {
				const body = await reposRes.json().catch(() => null);
				return { linked, repositories: [], error: body?.message || LOAD_ERROR };
			}
			const data = await reposRes.json();
			const repositories = Array.isArray(data) ? data : (data?.repositories ?? []);
			return { linked, repositories, error: null };
		} catch {
			return { linked: null, repositories: [], error: LOAD_ERROR };
		}
	}

	export interface PickedRepo {
		fullName: string;
		url: string;
		private: boolean;
	}

	interface ParsedRepo {
		owner: string;
		repo: string;
		url: string;
	}

	export function parseRepoInput(value: string): ParsedRepo | null {
		const gh = value.match(
			/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:[/#?].*)?$/i
		);
		if (gh) return { owner: gh[1], repo: gh[2], url: `https://github.com/${gh[1]}/${gh[2]}` };
		const short = value.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
		if (short) {
			return { owner: short[1], repo: short[2], url: `https://github.com/${short[1]}/${short[2]}` };
		}
		if (!value.startsWith('https://')) return null;
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			return null;
		}
		const segments = parsed.pathname.split('/').filter(Boolean);
		if (segments.length < 2 || parsed.username || parsed.password) return null;
		const repo = segments[segments.length - 1].replace(/\.git$/, '');
		if (!repo) return null;
		return { owner: segments.slice(0, -1).join('/'), repo, url: value.replace(/\/+$/, '') };
	}
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ChevronDown, Github, Loader2, X } from 'lucide-svelte';
	import { Badge, Input, PopoverPanel } from '$lib/components/ui';
	import RepoAccountPicker from './RepoAccountPicker.svelte';

	interface Repository {
		id: number;
		full_name: string;
		private: boolean;
	}

	let {
		onpick,
		onclear,
		selected = $bindable(null),
		autofocus = false,
		load = true
	}: {
		onpick: (repo: PickedRepo) => void;
		onclear?: () => void;
		selected?: string | null;
		autofocus?: boolean;
		load?: boolean;
	} = $props();

	const uid = $props.id();
	const searchId = `${uid}-repo-search`;

	let rootEl = $state<HTMLElement | null>(null);
	let repositories = $state<Repository[]>([]);
	let loadingRepos = $state(false);
	let reposError = $state<string | null>(null);
	let linked = $state<boolean | null>(null);
	let installUrl = $state<string | null>(null);
	let selectedAccount = $state<string | null>(null);
	let directLinkMode = $state(false);
	let query = $state('');
	let pickerOpen = $state(false);

	const accounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const r of repositories) {
			const owner = r.full_name.split('/')[0];
			counts.set(owner, (counts.get(owner) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([login, count]) => ({ login, count }))
			.sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
	});

	const filteredRepos = $derived(
		repositories.filter((r) => {
			const q = query.toLowerCase();
			const matchesText =
				r.full_name.toLowerCase().includes(q) ||
				r.full_name.split('/')[1].toLowerCase().includes(q);
			if (!matchesText) return false;
			if (q.includes('/')) return true;
			return !selectedAccount || r.full_name.split('/')[0] === selectedAccount;
		})
	);
	const parsedInput = $derived(selected ? null : parseRepoInput(query.trim()));
	const parsedIsListed = $derived(
		!!parsedInput &&
			filteredRepos.some(
				(r) =>
					r.full_name.toLowerCase() === `${parsedInput.owner}/${parsedInput.repo}`.toLowerCase()
			)
	);

	$effect(() => {
		if (!pickerOpen) return;
		const t = setTimeout(() => document.getElementById(searchId)?.focus(), 30);
		return () => clearTimeout(t);
	});

	onMount(() => {
		void (async () => {
			if (load) await loadGitHub();
			else directLinkMode = true;
			if (!autofocus) return;
			await tick();
			rootEl?.querySelector<HTMLElement>('.picker-trigger')?.focus();
		})();
	});

	async function loadGitHub() {
		loadingRepos = true;
		void apiFetch('/apiv1/github/app/install')
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => (installUrl = data?.url ?? null))
			.catch(() => (installUrl = null));
		const listing = await loadGitHubRepos();
		linked = listing.linked;
		loadingRepos = false;
		if (linked === false) {
			directLinkMode = true;
			return;
		}
		repositories = listing.repositories;
		reposError = listing.error;
		selectedAccount = selected?.split('/')[0] ?? accounts[0]?.login ?? null;
	}

	function pick(repo: PickedRepo) {
		selected = repo.fullName;
		query = '';
		onpick(repo);
	}

	function pickListed(repo: Repository) {
		selectedAccount = repo.full_name.split('/')[0];
		pick({
			fullName: repo.full_name,
			url: `https://github.com/${repo.full_name}`,
			private: repo.private
		});
	}

	function pickParsed(parsed: ParsedRepo) {
		pick({ fullName: `${parsed.owner}/${parsed.repo}`, url: parsed.url, private: false });
	}

	function clear() {
		const had = selected !== null;
		selected = null;
		query = '';
		if (had) onclear?.();
	}

	function selectAccount(login: string) {
		if (directLinkMode) clear();
		directLinkMode = false;
		selectedAccount = login;
		if (!selected) query = '';
	}

	function useDirectLink() {
		clear();
		directLinkMode = true;
		pickerOpen = false;
	}

	function handleDirectInput(value: string) {
		query = value;
		const parsed = parseRepoInput(value.trim());
		if (parsed) {
			selected = `${parsed.owner}/${parsed.repo}`;
			onpick({ fullName: selected, url: parsed.url, private: false });
		} else if (selected !== null) {
			selected = null;
			onclear?.();
		}
	}

	function handleSearchKeydown(e: KeyboardEvent, close: () => void) {
		if (e.key !== 'Enter' || e.isComposing) return;
		e.preventDefault();
		if (parsedInput && !parsedIsListed) pickParsed(parsedInput);
		else if (filteredRepos[0]) pickListed(filteredRepos[0]);
		else return;
		close();
	}

	function optionLabel(fullName: string) {
		const [owner, name] = fullName.split('/');
		return owner === selectedAccount ? name : fullName;
	}
</script>

<div class="ghp" bind:this={rootEl}>
	<div class="ghp-split">
		<RepoAccountPicker
			{accounts}
			selected={selectedAccount}
			onSelect={selectAccount}
			{installUrl}
			directLink={directLinkMode}
			onDirectLink={useDirectLink}
		/>
		{#if directLinkMode}
			<div class="picker-wrap">
				<input
					class="picker-trigger picker-input"
					value={query}
					oninput={(e) => handleDirectInput(e.currentTarget.value)}
					placeholder="https://github.com/owner/repo"
					autocomplete="off"
					spellcheck="false"
					aria-label="Repository URL"
				/>
				{#if query}
					<button
						type="button"
						class="picker-suffix picker-clear"
						aria-label="Clear repository"
						onclick={clear}
					>
						<X size={15} />
					</button>
				{/if}
			</div>
		{:else}
			<PopoverPanel sameWidth bind:open={pickerOpen}>
				{#snippet trigger(attrs, open)}
					<div class="picker-wrap">
						<button
							type="button"
							class="picker-trigger"
							class:picker-trigger--locked={!!selected}
							{...attrs}
							disabled={!!selected}
						>
							{#if selected}
								<Github class="h-4 w-4 shrink-0" />
								<span class="picker-value">{selected}</span>
							{:else if query}
								<span class="picker-value">{query}</span>
							{:else}
								<span class="picker-placeholder">Search your repositories</span>
							{/if}
						</button>
						{#if loadingRepos}
							<span class="picker-suffix"><Loader2 class="h-4 w-4 animate-spin" /></span>
						{:else if selected}
							<button
								type="button"
								class="picker-suffix picker-clear"
								aria-label="Clear repository"
								onclick={clear}
							>
								<X size={15} />
							</button>
						{:else}
							<span class="picker-suffix picker-chevron" class:picker-chevron--open={open}
								><ChevronDown size={15} /></span
							>
						{/if}
					</div>
				{/snippet}
				{#snippet children({ close })}
					<Input
						id={searchId}
						value={query}
						oninput={(e: Event) => (query = (e.target as HTMLInputElement).value)}
						onkeydown={(e: KeyboardEvent) => handleSearchKeydown(e, close)}
						placeholder="owner/repo or GitHub URL"
						autocomplete="off"
						readonly={selected !== null}
					/>
					<div class="picker-list">
						{#if parsedInput && !parsedIsListed}
							<button
								type="button"
								class="picker-option picker-option--manual"
								onclick={() => {
									pickParsed(parsedInput);
									close();
								}}
							>
								<Github class="h-4 w-4 shrink-0" />
								<span class="picker-option-text"
									>Use <strong>{parsedInput.owner}/{parsedInput.repo}</strong></span
								>
							</button>
						{/if}
						{#if loadingRepos}
							<div class="picker-empty">
								<Loader2 class="h-4 w-4 animate-spin" /> Loading your repositories
							</div>
						{:else}
							{#each filteredRepos as repo (repo.full_name)}
								<button
									type="button"
									class="picker-option"
									onclick={() => {
										pickListed(repo);
										close();
									}}
								>
									<Github class="h-4 w-4 shrink-0" />
									<span class="picker-option-text">{optionLabel(repo.full_name)}</span>
									{#if repo.private}<Badge tone="neutral">Private</Badge>{/if}
								</button>
							{:else}
								{#if reposError}
									<div class="picker-note">
										{reposError}
										<a href="/user/settings">Connect GitHub</a>
									</div>
								{:else if !query}
									<div class="picker-empty">
										Search your repos, or paste owner/repo or a GitHub URL
									</div>
								{:else if !parsedInput}
									<div class="picker-empty">
										No matches. Paste owner/repo or a GitHub URL to use any public repo.
									</div>
								{/if}
							{/each}
						{/if}
					</div>
				{/snippet}
			</PopoverPanel>
		{/if}
	</div>
	{#if linked === false}
		<p class="ghp-hint">
			Paste a public repo link, or <a href="/user/settings">connect GitHub</a> to pick from your own.
		</p>
	{/if}
</div>

<style>
	.ghp {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		container-type: inline-size;
	}

	.ghp-split {
		display: grid;
		grid-template-columns: minmax(8rem, 11rem) minmax(0, 1fr);
		gap: 0.5rem;
	}

	@container (max-width: 22rem) {
		.ghp-split {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.ghp-hint {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.ghp-hint a {
		color: var(--text-link);
		font-weight: 600;
		text-decoration: underline;
	}

	.picker-wrap {
		position: relative;
		min-width: 0;
	}

	.picker-trigger {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		height: 2.25rem;
		padding: 0 2.25rem 0 0.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background-color: var(--bg-surface);
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}

	.picker-trigger:hover:not(:disabled) {
		border-color: var(--border-strong);
	}

	.picker-trigger:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring-color);
		outline-offset: var(--focus-ring-offset);
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.picker-input {
		font-family: var(--font-mono);
		cursor: text;
	}

	.picker-input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.picker-input::placeholder {
		color: var(--text-faint);
	}

	.picker-trigger:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.picker-trigger--locked:disabled {
		opacity: 1;
	}

	.picker-value {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.picker-placeholder {
		color: var(--text-faint);
	}

	.picker-suffix {
		position: absolute;
		right: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		color: var(--text-muted);
	}

	.picker-clear {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.picker-clear:hover {
		color: var(--text-default);
	}

	.picker-chevron {
		pointer-events: none;
		transition: transform var(--dur-fast) ease;
	}

	.picker-chevron--open {
		transform: translateY(-50%) rotate(180deg);
	}

	.picker-list {
		display: flex;
		flex-direction: column;
		margin-top: 0.5rem;
		max-height: 12rem;
		overflow-y: auto;
		scrollbar-gutter: stable;
	}

	.picker-option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem;
		text-align: left;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		border: none;
		background: none;
		color: var(--text-default);
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.picker-option:hover {
		background-color: color-mix(in srgb, var(--border-default) 40%, transparent);
	}

	.picker-option-text {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.picker-empty {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.picker-note {
		padding: 0.75rem;
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--text-muted);
		background-color: var(--status-warning-bg);
		border: 1px solid var(--status-warning-border);
		border-radius: var(--radius-sm);
		margin: 0.25rem;
	}

	.picker-note a {
		color: var(--text-link);
		font-weight: 600;
		text-decoration: underline;
	}

	.picker-option--manual {
		border-bottom: 1px solid var(--border-default);
		border-radius: 0;
	}

	.picker-option--manual strong {
		font-weight: 600;
	}
</style>
