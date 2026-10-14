<script lang="ts">
	import { CircleDot, X } from 'lucide-svelte';
	import PopoverPanel from '@orchardlabs/graft-ui/components/ui/PopoverPanel.svelte';
	import SegmentedControl from '@orchardlabs/graft-ui/components/ui/SegmentedControl.svelte';
	import Skeleton from '@orchardlabs/graft-ui/components/ui/Skeleton.svelte';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import { linearIssues } from './integrations';
	import type { GhIssue, IssueProvider, PickedIssue } from './types';

	let {
		value = $bindable<PickedIssue | null>(null),
		sandboxId,
		repo,
		running,
		disabled = false
	}: {
		value?: PickedIssue | null;
		sandboxId: string | null;
		repo: string | null;
		running: boolean;
		disabled?: boolean;
	} = $props();

	const app = getGreenhouseApp();

	const PROVIDERS = [
		{ value: 'github', label: 'GitHub' },
		{ value: 'linear', label: 'Linear' }
	];

	let open = $state(false);
	let provider = $state<IssueProvider>('github');
	let query = $state('');
	let issues = $state.raw<GhIssue[]>([]);
	let phase = $state<'idle' | 'loading' | 'ready' | 'disconnected' | 'unavailable' | 'error'>(
		'idle'
	);
	let message = $state('');
	let source = $state<string | null>(null);

	const typedRef = $derived.by(() => {
		const q = query.trim();
		if (provider === 'linear') return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q) ? q.toUpperCase() : null;
		return /^[\w.-]+\/[\w.-]+#\d+$/.test(q) || /^#?\d+$/.test(q) ? q : null;
	});

	let timer: ReturnType<typeof setTimeout> | null = null;
	let seq = 0;

	$effect(() => {
		const key = open ? `${provider}|${query.trim()}|${repo ?? ''}|${running}|${sandboxId}` : null;
		if (!key) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(
			() => {
				search();
			},
			query.trim() ? 250 : 0
		);
		return () => {
			if (timer) clearTimeout(timer);
		};
	});

	async function search() {
		const id = ++seq;
		const q = query.trim();
		const which = provider;
		if (which === 'github' && (!sandboxId || !running || !repo)) {
			phase = 'unavailable';
			message = !running
				? 'Start the machine to list the issues of its repositories.'
				: 'Pick a repository first.';
			issues = [];
			return;
		}
		phase = 'loading';
		try {
			if (which === 'linear') {
				const res = await linearIssues(q);
				if (id !== seq) return;
				if (!res.connected) {
					phase = 'disconnected';
					issues = [];
					return;
				}
				issues = res.issues ?? [];
				source = null;
				phase = 'ready';
				return;
			}
			const res = await api.listIssues(sandboxId as string, 'github', { repo, q });
			if (id !== seq) return;
			if (!res.ok) {
				phase = 'error';
				message = res.message;
				issues = [];
				return;
			}
			issues = res.data.issues ?? [];
			source = res.data.repo ?? null;
			phase = 'ready';
		} catch (e) {
			if (id !== seq) return;
			phase = 'error';
			message = e instanceof Error ? e.message : 'Could not load issues';
			issues = [];
		}
	}

	function pick(issue: GhIssue) {
		value = { provider: issue.provider, ref: issue.ref, title: issue.title };
		open = false;
	}

	function useTyped() {
		if (!typedRef) return;
		const ref =
			provider === 'github' && /^#?\d+$/.test(typedRef) && source
				? `${source}#${typedRef.replace('#', '')}`
				: typedRef;
		value = { provider, ref, title: null };
		open = false;
	}

	function clear() {
		value = null;
		open = false;
	}
</script>

<PopoverPanel bind:open placement="bottom-start">
	{#snippet trigger(props, isOpen)}
		<button
			{...props}
			type="button"
			class="chip"
			class:chip--set={!!value}
			aria-expanded={isOpen}
			aria-label={value ? undefined : 'Start from an issue'}
			{disabled}
			title={value?.title ?? 'Start from an issue'}
		>
			<CircleDot size={16} strokeWidth={1.75} />
			{#if value}<span class="chip-label">{value.ref}</span>{/if}
		</button>
	{/snippet}
	<div class="picker" data-align="issue-picker">
		<div class="top">
			<SegmentedControl
				options={PROVIDERS}
				bind:value={() => provider, (v) => (provider = v as IssueProvider)}
				label="Issue tracker"
				grow
			/>
			<input
				class="gh-field"
				bind:value={query}
				placeholder={provider === 'linear' ? 'Search, or ENG-123' : 'Search, or #123'}
				aria-label="Search issues"
				disabled={phase === 'disconnected'}
				onkeydown={(e) => {
					if (e.key === 'Enter' && typedRef && issues.length === 0) useTyped();
				}}
			/>
		</div>

		<div class="results gh-scroll">
			{#if phase === 'loading' || phase === 'idle'}
				<div class="skeletons">
					<Skeleton height="0.625rem" width="70%" />
					<Skeleton height="0.625rem" width="55%" />
					<Skeleton height="0.625rem" width="62%" />
				</div>
			{:else if phase === 'disconnected'}
				<div class="empty">
					<p>Connect your Linear account to pick its issues.</p>
					<button
						type="button"
						class="gh-btn"
						onclick={() => {
							open = false;
							app.openSettings('integrations');
						}}>Connect Linear</button
					>
				</div>
			{:else if phase === 'unavailable' || phase === 'error'}
				<p class="note">{message}</p>
			{:else}
				{#each issues.slice(0, 8) as issue (issue.ref)}
					<button
						type="button"
						class="issue"
						class:issue--on={value?.ref === issue.ref}
						onclick={() => pick(issue)}
					>
						<span class="ref gh-mono">{issue.ref.replace(/^[^#]*#/, '#')}</span>
						<span class="title">{issue.title}</span>
						{#if issue.state}<span class="state">{issue.state}</span>{/if}
					</button>
				{:else}
					<p class="note">
						{query.trim() ? 'No open issues match.' : 'No open issues.'}
					</p>
				{/each}
			{/if}
			{#if typedRef && phase !== 'disconnected'}
				<button type="button" class="issue" onclick={useTyped}>
					<span class="ref gh-mono">{typedRef}</span>
					<span class="title">Use this reference</span>
				</button>
			{/if}
		</div>

		<div class="foot">
			<span class="note">
				{provider === 'github' && source
					? `Open issues in ${source}`
					: 'The agent reads the issue and its comments before it starts.'}
			</span>
			{#if value}
				<button type="button" class="gh-btn gh-btn--ghost" onclick={clear}>
					<X size={14} strokeWidth={1.75} /> Remove
				</button>
			{/if}
		</div>
	</div>
</PopoverPanel>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		min-width: var(--gh-icon);
		max-width: 16rem;
		height: var(--gh-icon);
		padding: 0 var(--gh-ibtn-inset);
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		white-space: nowrap;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}

	.chip-label {
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

	.chip--set {
		padding: 0 0.5rem 0 var(--gh-ibtn-inset);
		color: var(--gh-text);
		background: var(--gh-selected);
	}

	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 26rem;
		max-width: calc(100vw - 2rem);
	}

	.top {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.results {
		display: flex;
		flex-direction: column;
		min-height: 6rem;
		max-height: 18rem;
	}

	.issue {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: var(--gh-row);
		padding: 0 0.5rem;
		border-radius: var(--gh-r-row);
		text-align: left;
		color: var(--gh-text);
		transition: background-color var(--dur-fast) ease;
	}

	.issue:hover,
	.issue--on {
		background: var(--gh-hover);
	}

	.ref {
		flex: none;
		min-width: 3rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.state {
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.note {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.results > .note {
		padding: 0.5rem;
	}

	.empty {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem;
	}

	.empty p {
		margin: 0;
		color: var(--gh-muted);
	}

	.skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem 0.5rem;
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-height: var(--gh-icon);
		padding: 0.5rem 0.5rem 0;
		border-top: 1px solid var(--gh-line);
	}
</style>
