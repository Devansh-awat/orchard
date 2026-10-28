<script lang="ts">
	import { GitBranch, Gitlab, Lock, Plus } from 'lucide-svelte';
	import {
		Alert,
		Field,
		Input,
		Menu,
		MenuItem,
		SearchPicker,
		SelectTrigger,
		type DropdownOption
	} from '$lib/components/ui';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import {
		detectGitRepo,
		fetchGitBranches,
		fetchGitConnections,
		fetchGitRepos,
		providerLabel,
		repoPathOn,
		type GitBranch as Branch,
		type GitConnection,
		type GitRepo
	} from '$lib/components/user-settings/git-connections';

	let {
		onSelect,
		onDetect
	}: {
		onSelect: (
			sel: {
				connectionId: string;
				repoUrl: string;
				repoPath: string;
				branch: string;
				externalRepoId: string | null;
			} | null
		) => void;
		onDetect: (det: Record<string, unknown>) => void;
	} = $props();

	let connections = $state<GitConnection[]>([]);
	let loaded = $state(false);
	let connectionId = $state('');
	let repos = $state<GitRepo[]>([]);
	let loadingRepos = $state(false);
	let repoQuery = $state('');
	let repoUrl = $state('');
	let selectedRepo = $state<GitRepo | null>(null);
	let branches = $state<Branch[]>([]);
	let loadingBranches = $state(false);
	let branch = $state('');
	let detecting = $state(false);
	let detectRun = 0;

	const connection = $derived(connections.find((c) => c.id === connectionId) ?? null);
	const repoOptions = $derived(repos.map((r) => ({ value: r.id, label: r.fullName })));
	const branchOptions = $derived(branches.map((b) => ({ value: b.name, label: b.name })));
	const glyphFor = (provider: GitConnection['provider']) =>
		provider === 'gitlab' ? Gitlab : GitBranch;
	const repoPath = $derived(
		connection ? (selectedRepo ? selectedRepo.fullName : repoPathOn(connection, repoUrl)) : null
	);

	$effect(() => {
		fetchGitConnections()
			.then((list) => {
				connections = list;
				if (!connectionId && list[0]) pickConnection(list[0].id);
			})
			.catch(() => {
				connections = [];
			})
			.finally(() => {
				loaded = true;
			});
	});

	async function pickConnection(id: string) {
		connectionId = id;
		selectedRepo = null;
		repos = [];
		branches = [];
		branch = '';
		repoUrl = '';
		repoQuery = '';
		onSelect(null);
		const c = connections.find((x) => x.id === id);
		if (!c?.canList) return;
		loadingRepos = true;
		try {
			repos = await fetchGitRepos(id);
		} catch {
			repos = [];
		} finally {
			loadingRepos = false;
		}
	}

	async function pickRepo(r: GitRepo) {
		selectedRepo = r;
		repoUrl = r.url;
		repoQuery = r.fullName;
		await loadBranches(r.fullName, r.defaultBranch);
	}

	async function loadBranches(path: string, preferred: string | null) {
		if (!connection) return;
		loadingBranches = true;
		branches = [];
		try {
			branches = connection.canList ? await fetchGitBranches(connection.id, path) : [];
		} catch {
			branches = [];
		} finally {
			loadingBranches = false;
		}
		const pick =
			(preferred && branches.find((b) => b.name === preferred)?.name) ||
			branches.find((b) => b.name === 'main' || b.name === 'master')?.name ||
			branches[0]?.name ||
			preferred ||
			'main';
		setBranch(pick);
	}

	function setBranch(name: string) {
		branch = name;
		emit();
		detect();
	}

	function emit() {
		if (!connection || !repoPath || !branch) {
			onSelect(null);
			return;
		}
		onSelect({
			connectionId: connection.id,
			repoUrl: selectedRepo?.url ?? repoUrl.trim().replace(/\.git$/, ''),
			repoPath,
			branch,
			externalRepoId: selectedRepo?.id ?? null
		});
	}

	async function detect() {
		if (!connection?.canList || !repoPath || !branch) return;
		const run = ++detectRun;
		detecting = true;
		try {
			const det = await detectGitRepo(connection.id, repoPath, branch);
			if (run === detectRun) onDetect(det);
		} catch {
			return;
		} finally {
			if (run === detectRun) detecting = false;
		}
	}

	function isUrl(text: string) {
		return /^https?:\/\//.test(text);
	}

	function useTypedUrl(text: string) {
		repoUrl = text;
		onUrlInput();
	}

	function clearRepo() {
		if (urlTimer) clearTimeout(urlTimer);
		selectedRepo = null;
		repoUrl = '';
		repoQuery = '';
		branches = [];
		branch = '';
		onSelect(null);
	}

	let urlTimer: ReturnType<typeof setTimeout> | null = null;
	function onUrlInput() {
		selectedRepo = null;
		if (urlTimer) clearTimeout(urlTimer);
		urlTimer = setTimeout(() => {
			if (connection && repoPathOn(connection, repoUrl)) {
				loadBranches(repoPathOn(connection, repoUrl)!, null);
			} else {
				onSelect(null);
			}
		}, 400);
	}
</script>

{#snippet lock(option: DropdownOption)}
	{#if repos.find((r) => r.id === option.value)?.private}
		<Lock size={13} class="text-faint" aria-label="Private" />
	{/if}
{/snippet}

{#snippet hostGlyph(c: GitConnection)}
	{@const Glyph = glyphFor(c.provider)}
	<Glyph size={15} class="text-muted" />
{/snippet}

{#if !loaded}
	<div class="gs-span gs-loading"><Spinner size={16} label="Loading git providers" /></div>
{:else if connections.length === 0}
	<div class="gs-span">
		<Alert tone="info" title="No git providers linked">
			Link GitLab, Gitea, Codeberg, Bitbucket or any git host under
			<a href="/user/settings?section=git">your settings</a>.
		</Alert>
	</div>
{:else}
	<Field label="Provider">
		<Menu placement="bottom-start" sameWidth>
			{#snippet trigger(attrs, open)}
				<SelectTrigger
					{...attrs}
					{open}
					block
					value={connection?.name}
					placeholder="Provider"
					aria-label="Git provider"
				>
					{#snippet leading()}{#if connection}{@render hostGlyph(connection)}{/if}{/snippet}
				</SelectTrigger>
			{/snippet}
			{#each connections as c (c.id)}
				<MenuItem
					checked={c.id === connectionId}
					description={c.host}
					onclick={() => pickConnection(c.id)}
				>
					{#snippet leading()}{@render hostGlyph(c)}{/snippet}
					{c.name}
				</MenuItem>
			{/each}
			<MenuSeparator />
			<MenuItem icon={Plus} href="/user/settings?section=git">Link a provider</MenuItem>
		</Menu>
	</Field>

	<Field label="Repository">
		{#if connection?.canList}
			<SearchPicker
				block
				value={selectedRepo?.id ?? repoPath ?? ''}
				bind:query={repoQuery}
				options={repoOptions}
				loading={loadingRepos}
				placeholder="Choose a repository"
				searchPlaceholder="Search or paste a URL"
				creatable={isUrl(repoQuery.trim())}
				createLabel={() => 'Use this URL'}
				oncreate={(q) => useTypedUrl(q)}
				onchange={(id) => {
					const r = repos.find((x) => x.id === id);
					if (r) pickRepo(r);
				}}
				onclear={clearRepo}
				trailing={lock}
			>
				{#snippet leading()}{#if connection}{@render hostGlyph(connection)}{/if}{/snippet}
			</SearchPicker>
		{:else}
			<Input
				bind:value={repoUrl}
				placeholder="https://{connection?.host}/team/app"
				mono
				oninput={onUrlInput}
			/>
		{/if}
	</Field>

	<Field label="Branch">
		<SearchPicker
			block
			mono
			value={branch}
			options={branchOptions}
			loading={loadingBranches || detecting}
			disabled={!repoPath}
			placeholder="main"
			searchPlaceholder="Search or type a branch"
			creatable
			createLabel={(q) => `Use ${q}`}
			onchange={setBranch}
		>
			{#snippet leading()}<GitBranch size={15} class="text-muted" />{/snippet}
		</SearchPicker>
	</Field>
{/if}

<style>
	.gs-span {
		grid-column: 1 / -1;
	}
	.gs-loading {
		display: flex;
		align-items: center;
		padding: 0.5rem 0;
		color: var(--text-faint);
	}
</style>
