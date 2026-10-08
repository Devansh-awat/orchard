<script lang="ts">
	import {
		ArrowUp,
		Check,
		ChevronDown,
		CircleDot,
		ClipboardList,
		GitBranch,
		Monitor,
		Play,
		Plus,
		Square
	} from 'lucide-svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import PopoverPanel from '$lib/components/ui/PopoverPanel.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { sandboxStatus } from '$lib/components/ui/status';
	import { toasts } from '$lib/stores';
	import type { Sandbox } from '$lib/types/sandbox';
	import { getGreenhouseApp } from './app.svelte';
	import SessionGlyph from './SessionGlyph.svelte';
	import { ago, modKey, repoHue, repoInitial, runnerLabel } from './format';
	import { VIEWER_ONLY } from './workspace.svelte';

	let { initialRepo = null }: { initialRepo?: string | null } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const machine = $derived(app.machine);
	const mod = modKey();

	let prompt = $state('');
	let repo = $state<string | null>(null);
	let issueRef = $state('');
	let issueOpen = $state(false);
	let machineOpen = $state(false);
	let repoOpen = $state(false);
	let modelOpen = $state(false);
	let launching = $state(false);
	let queued = $state<{ repo: string; prompt: string } | null>(null);
	let box = $state<HTMLTextAreaElement | null>(null);

	const repos = $derived(ws?.repos ?? []);
	const chosen = $derived(repos.find((r) => r.name === repo) ?? repos[0] ?? null);
	const recent = $derived(
		[...(ws?.active ?? [])]
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			.slice(0, 6)
	);
	const stopped = $derived(machine?.status === 'stopped' || machine?.status === 'error');
	const canLaunch = $derived(
		!!ws && ws.canEdit && !!prompt.trim() && !launching && (stopped || (ws.running && !!chosen))
	);
	const models = $derived(ws?.store.models ?? []);
	const model = $derived(ws?.store.model ?? null);

	$effect(() => {
		if (initialRepo) repo = initialRepo;
	});

	$effect(() => {
		const pending = queued;
		if (!pending || !ws?.running || !ws.reposLoaded) return;
		queued = null;
		void launchNow(pending.repo, pending.prompt);
	});

	function meta(m: Sandbox) {
		return sandboxStatus(m.status, {
			applying: m.applying,
			applyError: m.applyError,
			desiredState: m.desiredState
		});
	}

	function parseIssue(): { provider: 'github' | 'linear'; ref: string } | undefined {
		const ref = issueRef.trim();
		if (!ref) return undefined;
		return { provider: /^[A-Z][A-Z0-9]+-\d+$/.test(ref) ? 'linear' : 'github', ref };
	}

	async function launchNow(name: string, text: string) {
		if (!ws) return;
		launching = true;
		try {
			const session = await ws.createSession({ repo: name, prompt: text, issue: parseIssue() });
			if (session) {
				prompt = '';
				issueRef = '';
			}
		} finally {
			launching = false;
		}
	}

	async function launch() {
		if (!canLaunch || !ws) return;
		const text = prompt.trim();
		if (stopped) {
			if (!ws.canStart) return;
			const name = chosen?.name ?? repo;
			if (!name) {
				toasts.add({
					title: 'Start the machine first',
					description: 'Then pick a repository for the session.',
					color: 'info'
				});
				await ws.lifecycle('start');
				return;
			}
			queued = { repo: name, prompt: text };
			toasts.add({
				title: `Starting ${machine?.name}`,
				description: 'Your session opens as soon as it is up.',
				color: 'info'
			});
			await ws.lifecycle('start');
			return;
		}
		if (!chosen) return;
		await launchNow(chosen.name, text);
	}

	function key(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void launch();
		}
	}

	function grow(node: HTMLTextAreaElement) {
		const fit = () => {
			node.style.height = 'auto';
			node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
		};
		node.addEventListener('input', fit);
		fit();
		return () => node.removeEventListener('input', fit);
	}

	export function focus() {
		box?.focus();
	}
</script>

<div class="home gh-scroll">
	<div class="inner">
		<h1 class="title">What should we build?</h1>

		<div class="composer" class:composer--off={!ws?.canEdit}>
			<textarea
				bind:this={box}
				bind:value={prompt}
				class="prompt"
				rows="3"
				placeholder={ws && !ws.canEdit
					? VIEWER_ONLY
					: 'Describe a change, paste an issue, or ask a question about the code'}
				disabled={!ws?.canEdit}
				onkeydown={key}
				{@attach grow}></textarea>
			<div class="row">
				<Menu bind:open={machineOpen} placement="bottom-start">
					{#snippet trigger(props, isOpen)}
						<button {...props} type="button" class="chip" aria-expanded={isOpen}>
							{#if machine}<StatusDot meta={meta(machine)} size={7} />{:else}<Monitor
									size={13}
									strokeWidth={1.75}
								/>{/if}
							<span>{machine?.name ?? 'Machine'}</span>
							<ChevronDown size={12} strokeWidth={1.75} />
						</button>
					{/snippet}
					{#each app.machines as m (m.id)}
						<MenuItem onclick={() => app.openMachine(m.id)}>
							<StatusDot meta={meta(m)} size={7} />
							<span>{m.name}</span>
							<span class="gh-menu-kbd">{runnerLabel(m.runner)}</span>
							{#if m.id === machine?.id}<Check size={13} />{/if}
						</MenuItem>
					{/each}
					<div class="gh-menu-sep"></div>
					<MenuItem onclick={() => (app.sheet = 'new-machine')}
						><Plus size={14} /> New machine…</MenuItem
					>
				</Menu>

				<Menu bind:open={repoOpen} placement="bottom-start">
					{#snippet trigger(props, isOpen)}
						<button
							{...props}
							type="button"
							class="chip"
							aria-expanded={isOpen}
							disabled={!ws?.running && repos.length === 0}
						>
							{#if chosen}
								<span class="ravatar" style="--hue: var({repoHue(chosen.name)})"
									>{repoInitial(chosen.name)}</span
								>
								<span>{chosen.name}</span>
								<span class="sep">·</span>
								<GitBranch size={12} strokeWidth={1.75} />
								<span class="gh-mono branch">{chosen.branch}</span>
							{:else}
								<GitBranch size={13} strokeWidth={1.75} />
								<span>{ws?.running ? 'Add a repository' : 'Repository'}</span>
							{/if}
							<ChevronDown size={12} strokeWidth={1.75} />
						</button>
					{/snippet}
					{#each repos as r (r.name)}
						<MenuItem onclick={() => (repo = r.name)}>
							<span class="ravatar" style="--hue: var({repoHue(r.name)})"
								>{repoInitial(r.name)}</span
							>
							<span>{r.name}</span>
							<span class="gh-menu-kbd gh-mono">{r.branch}</span>
							{#if chosen?.name === r.name}<Check size={13} />{/if}
						</MenuItem>
					{/each}
					{#if repos.length > 0}<div class="gh-menu-sep"></div>{/if}
					<MenuItem onclick={() => (app.sheet = 'add-repo')} disabled={!ws?.running || !ws.canEdit}>
						<Plus size={14} /> Clone a repository…
					</MenuItem>
				</Menu>

				<PopoverPanel bind:open={issueOpen} placement="bottom-start">
					{#snippet trigger(props, isOpen)}
						<button
							{...props}
							type="button"
							class="chip"
							class:chip--set={!!issueRef.trim()}
							aria-expanded={isOpen}
						>
							<CircleDot size={13} strokeWidth={1.75} />
							<span>{issueRef.trim() || 'Issue'}</span>
						</button>
					{/snippet}
					<div class="issue">
						<p class="issue-head">Start from an issue</p>
						<input
							class="gh-field gh-mono"
							bind:value={issueRef}
							placeholder="owner/repo#123 or ENG-42"
							aria-label="Issue reference"
							onkeydown={(e) => e.key === 'Enter' && (issueOpen = false)}
						/>
						<p class="issue-note">The agent reads the issue and its comments before it starts.</p>
					</div>
				</PopoverPanel>

				<span class="grow"></span>

				{#if models.length > 0}
					<Menu bind:open={modelOpen} placement="bottom-end">
						{#snippet trigger(props, isOpen)}
							<button {...props} type="button" class="chip chip--quiet" aria-expanded={isOpen}>
								<span>{model?.name ?? 'Model'}</span>
								<ChevronDown size={12} strokeWidth={1.75} />
							</button>
						{/snippet}
						{#each models.slice(0, 12) as m (`${m.providerID}/${m.modelID}`)}
							<MenuItem
								onclick={() => {
									if (!ws) return;
									ws.store.providerID = m.providerID;
									ws.store.modelID = m.modelID;
								}}
							>
								<span>{m.name}</span>
								{#if model && m.modelID === model.modelID && m.providerID === model.providerID}<Check
										size={13}
									/>{/if}
							</MenuItem>
						{/each}
					</Menu>
				{/if}
				<button
					type="button"
					class="chip chip--quiet"
					class:chip--set={ws?.store.plan}
					aria-pressed={ws?.store.plan ?? false}
					title="Plan first: the agent proposes a plan before it edits anything"
					onclick={() => ws && (ws.store.plan = !ws.store.plan)}
				>
					<ClipboardList size={13} strokeWidth={1.75} /> Plan
				</button>
				<button
					type="button"
					class="send"
					aria-label={stopped ? 'Start the machine and launch' : 'Start session'}
					title="{stopped ? 'Start the machine and launch' : 'Start session'} (Enter)"
					disabled={!canLaunch}
					onclick={launch}
				>
					<ArrowUp size={16} strokeWidth={2} />
				</button>
			</div>
		</div>
		<p class="hint">
			Each session gets its own branch and worktree, so you can run several side by side.
			<span class="gh-kbd">{mod}N</span> opens a new one from anywhere.
		</p>

		{#if recent.length > 0}
			<section class="list">
				<h2 class="list-head">Recent sessions</h2>
				{#each recent as s (s.id)}
					<button type="button" class="item" onclick={() => app.openSession(s.id)}>
						<SessionGlyph
							activity={ws?.activity(s) ?? s.activity}
							merged={s.prState === 'merged'}
						/>
						<span class="item-title">{s.title}</span>
						<span class="item-meta gh-mono">{s.repo} · {s.branch}</span>
						{#if s.diffstat && (s.diffstat.additions || s.diffstat.deletions)}
							<span class="gh-num item-stat">
								{#if s.diffstat.additions}<span class="gh-add">+{s.diffstat.additions}</span>{/if}
								{#if s.diffstat.deletions}<span class="gh-del">−{s.diffstat.deletions}</span>{/if}
							</span>
						{/if}
						<span class="item-time">{ago(s.updatedAt)}</span>
					</button>
				{/each}
			</section>
		{/if}

		<section class="list">
			<div class="list-bar">
				<h2 class="list-head">Machines</h2>
				<button
					type="button"
					class="gh-btn gh-btn--ghost"
					onclick={() => (app.sheet = 'new-machine')}
				>
					<Plus size={13} /> New machine
				</button>
			</div>
			{#each app.machines as m (m.id)}
				{@const mm = meta(m)}
				{@const isStopped = m.status === 'stopped' || m.status === 'error'}
				<div class="item item--machine" class:item--on={m.id === machine?.id}>
					<button type="button" class="item-main" onclick={() => app.openMachine(m.id)}>
						<StatusDot meta={mm} size={8} />
						<span class="item-title">{m.name}</span>
						<span class="item-meta"
							>{runnerLabel(m.runner)} · {mm.label}{m.owner && m.myRole && m.myRole !== 'owner'
								? ` · hosted by ${m.owner.username ?? m.owner.email}`
								: ''}</span
						>

						<span class="item-time">{m.lastActiveAt ? ago(m.lastActiveAt) : ''}</span>
					</button>
					{#if m.id === machine?.id && (isStopped ? ws?.canStart : ws?.canLifecycle)}
						{#if isStopped}
							<button
								type="button"
								class="gh-ibtn"
								aria-label="Start {m.name}"
								title="Start"
								disabled={!!ws.busy}
								onclick={() => ws?.lifecycle('start')}
							>
								<Play size={14} strokeWidth={1.75} />
							</button>
						{:else}
							<button
								type="button"
								class="gh-ibtn"
								aria-label="Stop {m.name}"
								title="Stop"
								disabled={!!ws.busy || m.status !== 'running'}
								onclick={() => ws?.lifecycle('stop')}
							>
								<Square size={13} strokeWidth={1.75} />
							</button>
						{/if}
					{/if}
				</div>
			{:else}
				<p class="empty">No machines yet. Create one to start coding with an agent.</p>
			{/each}
		</section>
	</div>
</div>

<style>
	.home {
		flex: 1;
		min-height: 0;
		background: var(--gh-editor);
	}

	.inner {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 46rem;
		margin: 0 auto;
		padding: clamp(3rem, 14vh, 9rem) 1.5rem 4rem;
	}

	.title {
		margin: 0 0 1.25rem;
		text-align: center;
		font-size: 1.625rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--gh-text);
	}

	.composer {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-xl);
		border: 1px solid var(--gh-composer-edge);
		background: var(--gh-composer);
		box-shadow: var(--gh-composer-shadow);
		transition: border-color var(--dur-fast) ease;
	}

	.composer:focus-within {
		border-color: color-mix(in oklab, var(--accent) 45%, var(--gh-composer-edge));
	}

	.composer--off {
		opacity: 0.7;
	}

	.prompt {
		width: 100%;
		min-height: 5.5rem;
		padding: 1rem 1.125rem 0.5rem;
		background: transparent;
		color: var(--gh-text);
		font-size: var(--text-body);
		line-height: 1.5;
		resize: none;
		outline: none;
	}

	.prompt::placeholder {
		color: var(--gh-faint);
	}

	.row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding: 0.5rem 0.625rem 0.625rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 16rem;
		height: 1.75rem;
		padding: 0 0.625rem;
		border-radius: var(--radius-pill);
		border: 1px solid var(--gh-line);
		color: var(--gh-muted);
		white-space: nowrap;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.chip > span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chip:hover:not(:disabled),
	.chip[aria-expanded='true'] {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.chip:disabled {
		opacity: 0.5;
	}

	.chip--quiet {
		border-color: transparent;
	}

	.chip--set {
		color: var(--gh-text);
		background: var(--gh-selected);
	}

	.sep {
		color: var(--gh-faint);
	}

	.branch {
		font-size: var(--gh-caption);
	}

	.ravatar {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		height: 1rem;
		border-radius: 0.25rem;
		background: color-mix(in oklab, var(--hue) 22%, var(--gh-editor));
		color: color-mix(in oklab, var(--hue) 80%, var(--text-default));
		font-size: var(--text-micro);
		font-weight: 700;
	}

	.grow {
		flex: 1;
	}

	.send {
		display: inline-grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--text-on-accent);
		transition:
			opacity var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.send:disabled {
		background: var(--gh-selected);
		color: var(--gh-faint);
	}

	.hint {
		margin: 0.75rem 0 0;
		text-align: center;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.issue {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 18rem;
	}

	.issue-head {
		margin: 0;
		font-weight: 500;
	}

	.issue-note {
		margin: 0;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin-top: 2.5rem;
	}

	.list-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.list-head {
		margin: 0 0 0.375rem;
		padding: 0 0.625rem;
		font-size: var(--gh-caption);
		font-weight: 500;
		color: var(--gh-faint);
	}

	.list-bar .list-head {
		margin: 0;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: 2.25rem;
		padding: 0 0.625rem;
		border-radius: var(--radius-sm);
		text-align: left;
		color: var(--gh-text);
		transition: background-color var(--dur-fast) ease;
	}

	.item:hover,
	.item--on {
		background: var(--gh-hover);
	}

	.item--machine {
		padding-right: 0.25rem;
	}

	.item-main {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex: 1;
		min-width: 0;
		height: 100%;
		text-align: left;
	}

	.item-title {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 500;
	}

	.item-meta {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.item-stat {
		display: inline-flex;
		gap: 0.375rem;
	}

	.item-time {
		flex: none;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.empty {
		margin: 0;
		padding: 0.5rem 0.625rem;
		color: var(--gh-faint);
	}
</style>
