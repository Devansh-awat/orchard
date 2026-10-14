<script module lang="ts">
	import type { GhChecks as CachedChecks } from './types';

	const cache = new Map<string, CachedChecks>();
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { ExternalLink, GitPullRequest, RefreshCw, Rocket, Trash2, Wand2 } from 'lucide-svelte';
	import Skeleton from '@orchardlabs/graft-ui/components/ui/Skeleton.svelte';
	import StatusDot from '@orchardlabs/graft-ui/components/ui/StatusDot.svelte';
	import { previewStatus, statusMeta, type StatusMeta } from '../../lib/status';
	import { getGreenhouseApp } from './app.svelte';
	import * as api from './api';
	import { httpsUrl } from './format';
	import { VIEWER_ONLY, hostOnly, isLegacy, type MachineWorkspace } from './workspace.svelte';
	import type { GhCheck, GhChecks, GhSession } from './types';

	let { ws, session }: { ws: MachineWorkspace; session: GhSession } = $props();

	const app = getGreenhouseApp();
	const hasPreview = $derived(!!session.previewDeploymentId || !!session.previewUrl);
	const preview = $derived(previewStatus(session.previewStatus));
	let removing = $state(false);

	async function removePreview() {
		if (removing) return;
		removing = true;
		await ws.removePreview(session);
		removing = false;
	}

	let data = $state.raw<GhChecks | null>(null);
	let phase = $state<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
	let failure = $state<string | null>(null);
	let expanded = $state<string | null>(null);

	const failing = $derived((data?.checks ?? []).filter((c) => isFailure(c)));
	const prMeta = $derived.by((): StatusMeta | null => {
		const pr = data?.pr;
		if (!pr) return null;
		if (pr.draft) return statusMeta('neutral', 'Draft');
		if (pr.state === 'merged') return statusMeta('info', 'Merged');
		if (pr.state === 'closed') return statusMeta('neutral', 'Closed');
		return statusMeta('success', 'Open');
	});

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
		const id = session.id;
		const res = await api.listChecks(ws.sandboxId, id);
		if (id !== session.id) return;
		if (res.ok) {
			data = res.data;
			cache.set(id, res.data);
			phase = 'ready';
		} else if (res.status === 404) {
			phase = 'unavailable';
		} else if (!data) {
			failure = res.message || 'Could not load checks';
			phase = 'error';
		}
	}

	$effect(() => {
		void session.id;
		untrack(() => {
			data = cache.get(session.id) ?? null;
			phase = data ? 'ready' : 'loading';
			failure = null;
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
	{#if hasPreview}
		<section class="group" aria-label="Preview deploy">
			<div class="head">
				<span class="head-title">Preview</span>
			</div>
			<div class="check">
				<svelte:element
					this={session.previewUrl ? 'a' : 'div'}
					class="check-row preview-row"
					href={session.previewUrl ?? undefined}
					target={session.previewUrl ? '_blank' : undefined}
					rel={session.previewUrl ? 'noopener' : undefined}
					title={session.previewUrl ? `Open ${session.previewUrl}` : undefined}
				>
					<span class="ico" data-align="right-edge"><StatusDot meta={preview} size={8} /></span>
					<span class="check-name gh-mono preview-url"
						>{session.previewUrl?.replace(/^https?:\/\//, '') ?? 'Waiting for an address'}</span
					>
					<span class="check-state" class:check-state--failed={preview.kind === 'error'}
						>{preview.label}</span
					>
				</svelte:element>
				{#if session.previewUrl}
					<a
						class="gh-ibtn"
						href={session.previewUrl}
						target="_blank"
						rel="noopener"
						aria-label="Open the preview"
						title="Open the preview"
					>
						<ExternalLink size={14} strokeWidth={1.75} />
					</a>
				{/if}
				<button
					type="button"
					class="gh-ibtn"
					aria-label="Remove preview"
					title={ws.isOwner ? 'Remove preview' : hostOnly('remove previews')}
					disabled={!ws.isOwner || removing}
					onclick={removePreview}
				>
					<Trash2 size={14} strokeWidth={1.75} />
				</button>
			</div>
		</section>
	{:else if ws.isOwner && !isLegacy(session)}
		<div class="fix fix--preview">
			<button type="button" class="gh-btn gh-btn--ghost" onclick={() => (app.sheet = 'preview')}>
				<Rocket size={14} strokeWidth={1.75} /> Deploy preview…
			</button>
			<span class="fix-note">Runs this branch as its own Orchard environment.</span>
		</div>
	{/if}

	{#if phase === 'loading'}
		<div class="skeletons">
			<Skeleton height="0.625rem" width="55%" />
			<Skeleton height="0.625rem" width="40%" />
		</div>
	{:else if phase === 'unavailable'}
		<p class="note">Checks appear once this session has a pull request.</p>
	{:else if phase === 'error'}
		<p class="note">
			{failure}
			<button
				type="button"
				class="retry"
				onclick={() => {
					phase = 'loading';
					void load();
				}}>Try again</button
			>
		</p>
	{:else}
		{#if data?.pr}
			<a
				class="pr"
				href={httpsUrl(data.pr.url) ?? undefined}
				target="_blank"
				rel="noopener"
				title="Open on GitHub"
			>
				<span class="ico" data-align="right-edge"
					><GitPullRequest size={16} strokeWidth={1.75} /></span
				>
				<span class="pr-title">{data.pr.title ?? `Pull request ${data.pr.number}`}</span>
				{#if prMeta}
					<span class="state"><StatusDot meta={prMeta} size={6} /> {prMeta.label}</span>
				{/if}
				<span class="ico ext"><ExternalLink size={14} strokeWidth={1.75} /></span>
			</a>
		{:else}
			<p class="note">No pull request yet. Create one from the button above to run CI.</p>
		{/if}

		{#if data && data.checks.length > 0}
			<section class="group" aria-label="Checks">
				<div class="head">
					<span class="head-title">Checks</span>
					<button
						type="button"
						class="gh-ibtn"
						aria-label="Refresh checks"
						title="Refresh checks"
						onclick={load}
					>
						<RefreshCw size={16} strokeWidth={1.75} />
					</button>
				</div>
				{#each data.checks as check (check.name)}
					{@const m = meta(check)}
					{@const checkUrl = httpsUrl(check.url)}
					<div class="check">
						<button
							type="button"
							class="check-row"
							aria-expanded={expanded === check.name}
							disabled={!check.logExcerpt}
							title={check.logExcerpt ? 'Show the log excerpt' : undefined}
							onclick={() => (expanded = expanded === check.name ? null : check.name)}
						>
							<span class="ico" data-align="right-edge"><StatusDot meta={m} size={8} /></span>
							<span class="check-name">{check.name}</span>
							<span class="check-state" class:check-state--failed={isFailure(check)}>{m.label}</span
							>
						</button>
						{#if checkUrl}
							<a
								class="gh-ibtn"
								href={checkUrl}
								target="_blank"
								rel="noopener"
								aria-label="Open {check.name}"
								title="Open {check.name} on GitHub"
							>
								<ExternalLink size={14} strokeWidth={1.75} />
							</a>
						{/if}
					</div>
					{#if expanded === check.name && check.logExcerpt}
						<pre class="log gh-mono gh-scroll">{check.logExcerpt}</pre>
					{/if}
				{/each}
			</section>
			{#if failing.length > 0}
				<div class="fix">
					<button
						type="button"
						class="gh-btn"
						class:gh-btn--primary={!ws.prIsPrimary}
						disabled={!ws.canEdit}
						title={ws.canEdit ? undefined : VIEWER_ONLY}
						onclick={fix}
					>
						<Wand2 size={14} strokeWidth={1.75} /> Fix with agent
					</button>
					<span class="fix-note">Sends the failing logs to the agent.</span>
				</div>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.checks {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: 1;
		min-height: 0;
		padding: 0.5rem calc(var(--gh-edge) - 0.5rem) 1rem;
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
	}

	.pr {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		height: var(--gh-row);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-row);
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
		font-weight: 600;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.ext {
		color: var(--gh-faint);
	}

	.group {
		display: flex;
		flex-direction: column;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--gh-list-row);
		padding: 0 calc(0.5rem - var(--gh-ibtn-inset)) 0 0.5rem;
	}

	.head-title {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.check {
		display: flex;
		align-items: center;
	}

	.check-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		height: var(--gh-list-row);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-row);
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
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.check-state--failed {
		color: var(--gh-text);
		font-weight: 600;
	}

	.log {
		max-height: 14rem;
		margin: 0.25rem 0.5rem 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--gh-r-row);
		background: var(--gh-sidebar);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		white-space: pre-wrap;
		color: var(--gh-muted);
	}

	.fix {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.5rem 0;
	}

	.fix-note,
	.retry {
		color: var(--gh-text);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.note {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.note {
		padding: 0.5rem;
	}

	.preview-row {
		color: var(--gh-text);
	}

	a.preview-row:hover {
		background: var(--gh-hover);
	}

	.preview-url {
		font-size: var(--gh-caption);
	}

	.fix--preview {
		padding: 0 0.5rem 0.5rem;
	}

	.skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem 0.5rem;
	}
</style>
