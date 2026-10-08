<script lang="ts">
	import { untrack } from 'svelte';
	import { ExternalLink, GitPullRequest, RefreshCw, Wand2 } from 'lucide-svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { statusMeta, type StatusMeta } from '$lib/components/ui/status';
	import * as api from './api';
	import { VIEWER_ONLY, isLegacy, type MachineWorkspace } from './workspace.svelte';
	import type { GhCheck, GhChecks, GhSession } from './types';

	let { ws, session }: { ws: MachineWorkspace; session: GhSession } = $props();

	let data = $state.raw<GhChecks | null>(null);
	let phase = $state<'loading' | 'ready' | 'unavailable'>('loading');
	let expanded = $state<string | null>(null);

	const failing = $derived((data?.checks ?? []).filter((c) => isFailure(c)));

	function isFailure(check: GhCheck) {
		return ['failure', 'timed_out', 'cancelled', 'action_required'].includes(
			check.conclusion ?? ''
		);
	}

	function meta(check: GhCheck): StatusMeta {
		if (check.status !== 'completed') {
			return statusMeta('progress', check.status === 'queued' ? 'Queued' : 'Running', true);
		}
		if (check.conclusion === 'success') return statusMeta('success', 'Passed');
		if (isFailure(check)) return statusMeta('error', 'Failed');
		return statusMeta('neutral', 'Skipped');
	}

	async function load() {
		if (isLegacy(session)) {
			phase = 'unavailable';
			return;
		}
		const res = await api.listChecks(ws.sandboxId, session.id);
		if (res.ok) {
			data = res.data;
			phase = 'ready';
		} else {
			phase = res.status === 404 ? 'unavailable' : 'ready';
		}
	}

	$effect(() => {
		void session.id;
		untrack(() => {
			phase = 'loading';
			data = null;
			void load();
		});
		const timer = setInterval(() => {
			if (!document.hidden) void load();
		}, 20_000);
		return () => clearInterval(timer);
	});

	function fix() {
		const logs = failing
			.map(
				(c) =>
					`### ${c.name}\n${c.logExcerpt ? '```\n' + c.logExcerpt + '\n```' : '(no log excerpt)'}`
			)
			.join('\n\n');
		void ws.queuePrompt(
			`These CI checks are failing on this branch. Find the cause and fix them.\n\n${logs}`
		);
		ws.host.openTab(null);
	}
</script>

<div class="checks gh-scroll">
	{#if phase === 'loading'}
		<div class="skeletons">
			<Skeleton height="0.625rem" width="55%" />
			<Skeleton height="0.625rem" width="40%" />
		</div>
	{:else if phase === 'unavailable'}
		<p class="note">Checks appear once this session has a pull request.</p>
	{:else}
		{#if data?.pr}
			<a class="pr" href={data.pr.url} target="_blank" rel="noopener">
				<GitPullRequest size={15} strokeWidth={1.75} />
				<span class="pr-title">{data.pr.title ?? `Pull request ${data.pr.number}`}</span>
				<span class="pr-state pr-state--{data.pr.state}"
					>{data.pr.draft ? 'Draft' : data.pr.state}</span
				>
				<ExternalLink size={13} strokeWidth={1.75} />
			</a>
		{:else}
			<p class="note">No pull request yet. Create one from the button above to run CI.</p>
		{/if}

		{#if data && data.checks.length > 0}
			<div class="head">
				<span>Checks</span>
				<span class="grow"></span>
				<button
					type="button"
					class="gh-ibtn"
					aria-label="Refresh checks"
					title="Refresh"
					onclick={load}
				>
					<RefreshCw size={14} strokeWidth={1.75} />
				</button>
			</div>
			{#each data.checks as check (check.name)}
				{@const m = meta(check)}
				<div class="check">
					<button
						type="button"
						class="check-row"
						aria-expanded={expanded === check.name}
						disabled={!check.logExcerpt}
						onclick={() => (expanded = expanded === check.name ? null : check.name)}
					>
						<StatusDot meta={m} size={8} />
						<span class="check-name">{check.name}</span>
						<span class="check-state">{m.label}</span>
					</button>
					{#if check.url}
						<a
							class="gh-ibtn"
							href={check.url}
							target="_blank"
							rel="noopener"
							aria-label="Open {check.name}"
						>
							<ExternalLink size={13} strokeWidth={1.75} />
						</a>
					{/if}
				</div>
				{#if expanded === check.name && check.logExcerpt}
					<pre class="log gh-mono gh-scroll">{check.logExcerpt}</pre>
				{/if}
			{/each}
			{#if failing.length > 0}
				<div class="fix">
					<button
						type="button"
						class="gh-btn gh-btn--primary"
						disabled={!ws.canEdit}
						title={ws.canEdit ? undefined : VIEWER_ONLY}
						onclick={fix}
					>
						<Wand2 size={14} /> Fix with agent
					</button>
					<span class="fix-note">Sends the failing logs to the agent.</span>
				</div>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.checks {
		flex: 1;
		min-height: 0;
		padding: 0.5rem 0.5rem 1rem;
	}

	.pr {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		border-radius: var(--radius-sm);
		color: var(--gh-text);
		transition: background-color var(--dur-fast) ease;
	}

	.pr:hover {
		background: var(--gh-hover);
	}

	.pr-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 500;
	}

	.pr-state {
		font-size: var(--gh-caption);
		text-transform: capitalize;
		color: var(--status-success);
	}

	.pr-state--merged {
		color: var(--hue-violet);
	}

	.pr-state--closed {
		color: var(--gh-faint);
	}

	.head {
		display: flex;
		align-items: center;
		height: 1.75rem;
		margin-top: 0.5rem;
		padding: 0 0.25rem 0 0.5rem;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.grow {
		flex: 1;
	}

	.check {
		display: flex;
		align-items: center;
	}

	.check-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex: 1;
		min-width: 0;
		height: 1.875rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-xs);
		text-align: left;
		color: var(--gh-text);
	}

	.check-row:hover:not(:disabled) {
		background: var(--gh-hover);
	}

	.check-row:disabled {
		cursor: default;
	}

	.check-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.check-state {
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.log {
		max-height: 14rem;
		margin: 0.25rem 0.5rem 0.5rem;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-xs);
		background: var(--gh-sidebar);
		font-size: var(--gh-caption);
		white-space: pre-wrap;
		color: var(--gh-muted);
	}

	.fix {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.75rem 0.5rem 0;
	}

	.fix-note,
	.note {
		margin: 0;
		font-size: var(--gh-caption);
		color: var(--gh-faint);
	}

	.note {
		padding: 0.5rem;
	}

	.skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0.75rem 0.5rem;
	}
</style>
