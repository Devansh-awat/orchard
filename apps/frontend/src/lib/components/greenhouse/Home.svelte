<script lang="ts">
	import { onMount } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import {
		ArrowUp,
		Check,
		ChevronDown,
		ChevronRight,
		FilePlus,
		Gauge,
		GitBranch,
		Github,
		Hammer,
		ListChecks,
		LoaderCircle,
		MessageSquare,
		Play,
		Plus,
		RotateCw,
		Square,
		SquareKanban,
		X
	} from 'lucide-svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { sandboxStatus } from '$lib/components/ui/status';
	import { toasts } from '$lib/stores';
	import type { Sandbox } from '$lib/types/sandbox';
	import { slide } from '$lib/utils/transitions';
	import McpServers from '$lib/components/sandbox/chat/McpServers.svelte';
	import ModelPicker from '$lib/components/sandbox/chat/ModelPicker.svelte';
	import { agentUsageQueryOptions, fmtResetTime } from '$lib/components/sandbox/chat/agent-usage';
	import { sendChord, sendIntent } from '$lib/components/sandbox/chat/composer-keys';
	import { askNotificationPermission } from './agent-alerts';
	import { getGreenhouseApp } from './app.svelte';
	import IssuePicker from './IssuePicker.svelte';
	import WakeUp from './WakeUp.svelte';
	import Pip from './mascot/Pip.svelte';
	import * as api from './api';
	import { linearStatus, linkedIntegrations, type IntegrationProvider } from './integrations';
	import RepoIcon from './RepoIcon.svelte';
	import SessionGlyph from './SessionGlyph.svelte';
	import { ago, modKey, runnerLabel } from './format';
	import { greenhousePrefs } from './prefs.svelte';
	import { VIEWER_ONLY, hostOnly } from './workspace.svelte';
	import type { PickedIssue } from './types';

	let { initialRepo = null }: { initialRepo?: string | null } = $props();

	const CONNECT_KEY = 'greenhouse.home.connect.dismissed';
	const CONNECT = [
		{ id: 'linear', name: 'Linear', caption: 'Start sessions from issues', icon: SquareKanban },
		{ id: 'github', name: 'GitHub', caption: 'Clone repos and open PRs', icon: Github },
		{ id: 'slack', name: 'Slack', caption: 'Start sessions from a thread', icon: MessageSquare }
	] as const;

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const machine = $derived(app.machine);

	let prompt = $state('');
	let repo = $state<string | null>(null);
	let issue = $state<PickedIssue | null>(null);
	let repoOpen = $state(false);
	let modeOpen = $state(false);
	let launching = $state(false);
	let blank = $state(false);
	let box = $state<HTMLTextAreaElement | null>(null);
	let linked = $state<Set<IntegrationProvider> | null>(null);
	let connectDismissed = $state(true);

	const repos = $derived(ws?.repos ?? []);
	const chosen = $derived(blank ? null : (repos.find((r) => r.name === repo) ?? repos[0] ?? null));
	const recent = $derived(
		[...(ws?.active ?? [])]
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			.slice(0, 6)
	);
	const stopped = $derived(machine?.status === 'stopped' || machine?.status === 'error');
	const canLaunch = $derived(
		!!ws && ws.canEdit && !!prompt.trim() && !launching && ws.running && ws.reposLoaded
	);
	const models = $derived(ws?.store.models ?? []);
	const launchChord = $derived(sendChord(greenhousePrefs.values.sendWith, modKey()));
	const plan = $derived(ws?.store.plan ?? false);

	const usageQuery = createQuery(() =>
		agentUsageQueryOptions(ws?.sandboxId ?? '', !!ws && ws.running && ws.canEdit)
	);
	const usage = $derived.by(() => {
		const data = usageQuery.data;
		if (!data?.available || !data.fiveHour) return null;
		const used = Math.max(0, Math.min(100, Math.round(data.fiveHour.usedPercent)));
		const resets = fmtResetTime(data.fiveHour.resetsAt);
		return {
			used,
			title: `Claude 5 hour limit, ${used}% used${resets ? `. Resets ${resets}` : ''}`
		};
	});

	const missing = $derived(linked ? CONNECT.filter((c) => !linked?.has(c.id)) : []);
	const showConnect = $derived(!connectDismissed && missing.length > 0);

	onMount(() => {
		try {
			connectDismissed = localStorage.getItem(CONNECT_KEY) === '1';
		} catch {
			connectDismissed = false;
		}
		if (connectDismissed) return;
		void Promise.all([linkedIntegrations(), linearStatus().catch(() => null)])
			.then(([list, linear]) => {
				const set = new Set<IntegrationProvider>((list.integrations ?? []).map((i) => i.provider));
				if (linear?.connected) set.add('linear');
				linked = set;
			})
			.catch(() => {
				linked = null;
			});
	});

	function dismissConnect() {
		connectDismissed = true;
		try {
			localStorage.setItem(CONNECT_KEY, '1');
		} catch {
			return;
		}
	}

	function blankName(text: string): string {
		const base =
			text
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, ' ')
				.trim()
				.split(' ')
				.filter(Boolean)
				.slice(0, 4)
				.join('-')
				.slice(0, 40)
				.replace(/-+$/, '') || 'scratch';
		const taken = new Set(repos.map((r) => r.name));
		if (!taken.has(base)) return base;
		for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
		return `${base}-${Date.now().toString(36)}`;
	}

	async function ensureRepo(name: string | null, text: string): Promise<string | null> {
		if (name || !ws) return name;
		const fresh = blankName(text);
		const res = await api.initRepo(ws.sandboxId, fresh);
		if (!res.ok) {
			toasts.add({
				title: 'Could not create the repository',
				description: res.message,
				color: 'error'
			});
			return null;
		}
		await ws.refreshRepos();
		return res.data.name;
	}

	$effect(() => {
		if (initialRepo) repo = initialRepo;
	});

	function meta(m: Sandbox) {
		return sandboxStatus(m.status, {
			applying: m.applying,
			applyError: m.applyError,
			desiredState: m.desiredState
		});
	}

	async function launchNow(requested: string | null, text: string) {
		if (!ws) return;
		launching = true;
		try {
			const name = await ensureRepo(requested, text);
			if (!name) return;
			const session = await ws.createSession({
				repo: name,
				prompt: text,
				issue: issue ? { provider: issue.provider, ref: issue.ref } : undefined
			});
			if (session) {
				prompt = '';
				issue = null;
				blank = false;
				repo = name;
			}
		} finally {
			launching = false;
		}
	}

	async function launch() {
		if (!canLaunch || !ws) return;
		if (greenhousePrefs.values.notifyAgent) askNotificationPermission();
		const text = prompt.trim();
		await launchNow(chosen?.name ?? null, text);
	}

	function key(event: KeyboardEvent) {
		if (sendIntent(event, greenhousePrefs.values.sendWith)) {
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

	function setPlan(on: boolean) {
		ws?.store.setPlan(on);
		modeOpen = false;
	}

	export function focus() {
		box?.focus();
	}
</script>

<div class="home gh-scroll">
	<div class="inner">
		<div class="stage">
			{#if !ws?.running}
				<div class="start" role="status">
					{#if machine && !stopped}
						<WakeUp status={machine.status} sandboxId={machine.id} />
					{:else}
						<span class="mark" aria-hidden="true"><Pip size={54} /></span>
						<h1 class="title" data-type="display">
							{machine ? `${machine.name} is asleep` : 'Select and start your machine'}
						</h1>
						<p class="start-text">
							{machine
								? 'Start it to chat with the agent. Your repositories and sessions live on it.'
								: app.machines.length > 0
									? 'Greenhouse runs on your own computer in the cloud. Pick one below.'
									: 'Greenhouse runs on your own computer in the cloud. Create one to start.'}
						</p>
						{#if machine}
							<button
								type="button"
								class="gh-btn gh-btn--primary start-btn"
								disabled={!ws?.canStart || !!ws?.busy}
								title={ws?.canStart ? undefined : 'Read-only guests cannot start this machine'}
								onclick={() => ws?.lifecycle('start')}
							>
								<Play size={14} strokeWidth={1.75} /> Start {machine.name}
							</button>
						{:else if app.machines.length === 0}
							<button
								type="button"
								class="gh-btn gh-btn--primary start-btn"
								onclick={() => (app.sheet = 'new-machine')}
							>
								<Plus size={14} strokeWidth={1.75} /> New machine
							</button>
						{/if}
					{/if}
				</div>
			{:else}
				<div class="hero">
					<span class="mark" aria-hidden="true"><Pip pose="wave" size={54} /></span>
					<h1 class="title" data-type="display">What should we build?</h1>
				</div>

				<div class="composer" class:composer--off={!ws?.canEdit}>
					<textarea
						bind:this={box}
						bind:value={prompt}
						class="prompt"
						rows="3"
						placeholder={ws && !ws.canEdit
							? VIEWER_ONLY
							: 'Ask Greenhouse to build, fix or explain'}
						aria-label="Prompt"
						disabled={!ws?.canEdit}
						onkeydown={key}
						{@attach grow}></textarea>
					<div class="bar">
						<IssuePicker
							bind:value={issue}
							sandboxId={ws?.sandboxId ?? null}
							repo={chosen?.name ?? null}
							running={!!ws?.running}
							disabled={!ws?.canEdit}
						/>
						<span class="grow"></span>
						<Menu bind:open={modeOpen} placement="bottom-end">
							{#snippet trigger(props, isOpen)}
								<button
									{...props}
									type="button"
									class="mode"
									class:mode--plan={plan}
									aria-expanded={isOpen}
									disabled={!ws?.canEdit}
									title={plan ? 'Plan: reads and proposes, edits nothing' : 'Build: edits files'}
								>
									{#if plan}<ListChecks size={14} strokeWidth={1.75} />{:else}<Hammer
											size={14}
											strokeWidth={1.75}
										/>{/if}
									<span>{plan ? 'Plan' : 'Build'}</span>
									<ChevronDown size={14} strokeWidth={1.75} />
								</button>
							{/snippet}
							<MenuItem onclick={() => setPlan(false)}>
								<Hammer size={14} strokeWidth={1.75} />
								<span class="menu-label">Build</span>
								{#if !plan}<Check size={13} />{/if}
							</MenuItem>
							<MenuItem onclick={() => setPlan(true)}>
								<ListChecks size={14} strokeWidth={1.75} />
								<span class="menu-label">Plan, read only</span>
								{#if plan}<Check size={13} />{/if}
							</MenuItem>
						</Menu>
						{#if ws && models.length > 0}
							<span class="model"><ModelPicker store={ws.store} placement="bottom-end" /></span>
						{/if}
						<button
							type="button"
							class="send"
							aria-label="Start session"
							title="Start session ({launchChord})"
							aria-busy={launching}
							disabled={!canLaunch}
							onclick={launch}
						>
							{#if launching}
								<span class="animate-spin inline-grid" data-motion="progress"
									><LoaderCircle size={16} strokeWidth={2} /></span
								>
							{:else}
								<ArrowUp size={16} strokeWidth={2} />
							{/if}
						</button>
					</div>
				</div>

				<div class="chips">
					<Menu bind:open={repoOpen} placement="bottom-start">
						{#snippet trigger(props, isOpen)}
							<button
								{...props}
								type="button"
								class="seg"
								aria-expanded={isOpen}
								disabled={!ws?.running && repos.length === 0}
								title={chosen ? `${chosen.name}, sessions branch off ${chosen.branch}` : undefined}
							>
								{#if chosen}
									<span class="seg-part">
										<RepoIcon name={chosen.name} github={chosen.github} icon={chosen.icon} />
										<span class="seg-text">{chosen.name}</span>
									</span>
									<span class="seg-part seg-part--branch">
										<GitBranch size={14} strokeWidth={1.75} />
										<span class="seg-text gh-mono">{chosen.branch}</span>
									</span>
								{:else if ws?.running && !ws.reposLoaded}
									<span class="seg-part">
										<span class="seg-text seg-text--muted">Loading repositories</span>
									</span>
								{:else}
									<span class="seg-part">
										<FilePlus size={14} strokeWidth={1.75} />
										<span class="seg-text">New empty repository</span>
									</span>
								{/if}
								<ChevronDown size={14} strokeWidth={1.75} />
							</button>
						{/snippet}
						{#each repos as r (r.name)}
							<MenuItem
								onclick={() => {
									repo = r.name;
									blank = false;
								}}
							>
								<RepoIcon name={r.name} github={r.github} icon={r.icon} />
								<span>{r.name}</span>
								<span class="gh-menu-kbd gh-mono">{r.branch}</span>
								{#if chosen?.name === r.name}<Check size={13} />{/if}
							</MenuItem>
						{/each}
						{#if repos.length > 0}<div class="gh-menu-sep"></div>{/if}
						<MenuItem
							onclick={() => {
								repo = null;
								blank = true;
							}}
							disabled={!ws?.canEdit}
						>
							<FilePlus size={14} /> New empty repository
							{#if !chosen}<Check size={13} />{/if}
						</MenuItem>
						<MenuItem
							onclick={() => (app.sheet = 'add-repo')}
							disabled={!ws?.running || !ws.isOwner}
							title={ws && !ws.isOwner ? hostOnly('clone repositories') : undefined}
						>
							<Plus size={14} /> Clone a repository…
						</MenuItem>
					</Menu>
					<span class="grow"></span>
					{#if ws?.running}
						<McpServers store={ws.store} placement="bottom-end" label="MCP tools" />
					{/if}
					{#if usage}
						<span class="chip" title={usage.title}>
							<Gauge size={14} strokeWidth={1.75} />
							<span class="gh-num">{usage.used}% used</span>
						</span>
					{/if}
				</div>
			{/if}

			{#if showConnect}
				<section class="connect" aria-label="Connect integrations" transition:slide>
					<div class="connect-bar">
						<h2 class="list-head">Connect integrations</h2>
						<button
							type="button"
							class="gh-ibtn"
							aria-label="Dismiss"
							title="Dismiss"
							onclick={dismissConnect}
						>
							<X size={14} strokeWidth={1.75} />
						</button>
					</div>
					<div class="cards">
						{#each missing as c (c.id)}
							<button type="button" class="card" onclick={() => app.openSettings('integrations')}>
								<span class="card-ico"><c.icon size={16} strokeWidth={1.75} /></span>
								<span class="card-text">
									<span class="card-name">{c.name}</span>
									<span class="card-cap">{c.caption}</span>
								</span>
								<span class="card-chev"><ChevronRight size={14} strokeWidth={1.75} /></span>
							</button>
						{/each}
					</div>
				</section>
			{/if}
		</div>

		{#if recent.length > 0}
			<section class="list">
				<h2 class="list-head">Recent sessions</h2>
				{#each recent as s (s.id)}
					<button type="button" class="item" onclick={() => app.openSession(s.id)}>
						<span class="ico"
							><SessionGlyph
								activity={ws?.activity(s) ?? s.activity}
								merged={s.prState === 'merged'}
							/></span
						>
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
					<Plus size={14} strokeWidth={1.75} /> New machine
				</button>
			</div>
			{#each app.machines as m (m.id)}
				{@const mm = meta(m)}
				{@const isStopped = m.status === 'stopped' || m.status === 'error'}
				<div class="item item--machine" class:item--on={m.id === machine?.id}>
					<button type="button" class="item-main" onclick={() => app.openMachine(m.id)}>
						<span class="ico"><StatusDot meta={mm} size={8} /></span>
						<span class="item-title">{m.name}</span>
						<span class="item-meta"
							>{runnerLabel(m.runner)} · {m.applyError
								? `Change failed: ${m.applyError}`
								: mm.label}{m.owner && m.myRole && m.myRole !== 'owner'
								? ` · hosted by ${m.owner.username ?? m.owner.email}`
								: ''}</span
						>

						<span class="item-time">{m.lastActiveAt ? ago(m.lastActiveAt) : ''}</span>
					</button>
					{#if m.id === machine?.id && m.applyError && ws?.canLifecycle}
						<button
							type="button"
							class="gh-ibtn"
							aria-label="Retry the change on {m.name}"
							title="The last change failed: {m.applyError}. Retry"
							disabled={!!ws.busy}
							onclick={() => ws?.retryApply()}
						>
							<RotateCw size={16} strokeWidth={1.75} />
						</button>
					{:else if m.id === machine?.id && (isStopped ? ws?.canStart : ws?.canLifecycle)}
						{#if isStopped}
							<button
								type="button"
								class="gh-ibtn"
								aria-label="Start {m.name}"
								title="Start {m.name}"
								disabled={!!ws.busy}
								onclick={() => ws?.lifecycle('start')}
							>
								<Play size={16} strokeWidth={1.75} />
							</button>
						{:else}
							<button
								type="button"
								class="gh-ibtn"
								aria-label="Stop {m.name}"
								title="Stop {m.name}"
								disabled={!!ws.busy || m.status !== 'running'}
								onclick={() => ws?.lifecycle('stop')}
							>
								<Square size={16} strokeWidth={1.75} />
							</button>
						{/if}
					{:else}
						<span class="slot" aria-hidden="true"></span>
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
		max-width: 41.5rem;
		min-height: 100%;
		margin: 0 auto;
		padding: 0 1.5rem 3rem;
	}

	.stage {
		display: flex;
		flex: 1 0 auto;
		flex-direction: column;
		justify-content: center;
		padding: 3rem 0 2rem;
	}

	.start {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0 2rem;
		text-align: center;
	}

	.start-text {
		max-width: 26rem;
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.start-btn {
		margin-top: 0.5rem;
	}

	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}

	.mark {
		display: inline-grid;
		place-items: center;
	}

	.title {
		margin: 0;
		text-align: center;
		font-size: 1.5rem;
		line-height: 2rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--gh-text);
	}

	.composer {
		display: flex;
		flex-direction: column;
		border-radius: var(--gh-r-sheet);
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
		display: block;
		width: 100%;
		min-height: calc(3 * var(--gh-lh-reading) + 1.5rem);
		margin: 0;
		padding: 1rem 1rem 0.5rem;
		border: none;
		background: transparent;
		resize: none;
		outline: none;
		font-family: inherit;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		letter-spacing: normal;
		text-indent: 0;
		text-align: start;
		vertical-align: top;
		color: var(--gh-text);
		caret-color: var(--accent);
	}

	.prompt::placeholder {
		font: inherit;
		letter-spacing: inherit;
		text-indent: 0;
		color: var(--gh-faint);
		opacity: 1;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem 0.5rem calc(1rem - var(--gh-ibtn-inset));
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	.mode {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: var(--gh-icon);
		padding: 0 0.375rem 0 0.5rem;
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		white-space: nowrap;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.mode:hover:not(:disabled),
	.mode[aria-expanded='true'] {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.mode--plan {
		color: var(--gh-text);
		background: var(--gh-selected);
	}

	.mode:disabled {
		opacity: 0.5;
	}

	.menu-label {
		flex: 1;
		min-width: 0;
		text-align: left;
	}

	.model {
		display: inline-flex;
		min-width: 0;
		padding-left: 0.5rem;
	}

	.send {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-icon);
		height: var(--gh-icon);
		border-radius: var(--gh-r-control);
		background: var(--accent);
		color: var(--text-on-accent);
		transition:
			opacity var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.send:hover:not(:disabled) {
		background: color-mix(in oklab, var(--accent) 88%, var(--text-default));
	}

	.send:disabled {
		background: var(--gh-selected);
		color: var(--gh-faint);
	}

	.chips {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.seg {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		max-width: 100%;
		height: var(--gh-icon);
		padding-right: 0.375rem;
		border: 1px solid var(--gh-line);
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		white-space: nowrap;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.seg:hover:not(:disabled),
	.seg[aria-expanded='true'] {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.seg:disabled {
		opacity: 0.5;
	}

	.seg-part {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		height: 100%;
		padding: 0 0.5rem;
	}

	.seg-part--branch {
		gap: 0.25rem;
		border-left: 1px solid var(--gh-line);
		color: var(--gh-faint);
	}

	.seg-text {
		min-width: 0;
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.seg-text--muted {
		color: var(--gh-faint);
	}

	.seg-part--branch .seg-text {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: var(--gh-icon);
		padding: 0 0.5rem;
		border: 1px solid var(--gh-line);
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		white-space: nowrap;
	}

	.connect {
		display: flex;
		flex-direction: column;
		margin-top: 2rem;
	}

	.connect-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.25rem;
		padding-right: calc(0.75rem - var(--gh-ibtn-inset));
	}

	.connect-bar .list-head {
		margin: 0;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.5rem;
	}

	.card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		padding: 0.75rem;
		border: 1px solid var(--gh-line);
		border-radius: var(--gh-r-row);
		text-align: left;
		color: var(--gh-text);
		transition:
			background-color var(--dur-fast) ease,
			border-color var(--dur-fast) ease;
	}

	.card:hover {
		background: var(--gh-hover);
	}

	.card:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.card-ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2rem;
		height: 2rem;
		border-radius: var(--gh-r-control);
		background: var(--fill-soft);
		color: var(--gh-muted);
	}

	.card-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	.card-name {
		font-weight: 600;
	}

	.card-cap {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.card-chev {
		display: inline-flex;
		flex: none;
		color: var(--gh-faint);
	}

	.list {
		display: flex;
		flex-direction: column;
	}

	.list + .list {
		margin-top: 2rem;
	}

	.list-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.25rem;
	}

	.list-head {
		margin: 0 0 0.25rem;
		padding: 0 0.75rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		font-weight: 400;
		color: var(--gh-faint);
	}

	.list-bar .list-head {
		margin: 0;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--gh-row);
		padding: 0 0.75rem;
		border-radius: var(--gh-r-row);
		text-align: left;
		color: var(--gh-muted);
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.item:hover {
		background: var(--gh-hover);
		color: var(--gh-text);
	}

	.item--on,
	.item--on:hover {
		background: var(--gh-selected);
		color: var(--gh-text);
	}

	.item--machine {
		padding-right: calc(0.75rem - var(--gh-ibtn-inset));
	}

	.item-main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		height: 100%;
		text-align: left;
		color: inherit;
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
	}

	.item-title {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.item-meta {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.item-stat {
		display: inline-flex;
		gap: 0.5rem;
	}

	.item-time {
		flex: none;
		min-width: 3.5rem;
		text-align: right;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		font-variant-numeric: tabular-nums;
		color: var(--gh-faint);
	}

	.slot {
		flex: none;
		width: var(--gh-icon);
	}

	.empty {
		margin: 0;
		padding: 0.5rem 0.75rem;
		color: var(--gh-faint);
	}
</style>
