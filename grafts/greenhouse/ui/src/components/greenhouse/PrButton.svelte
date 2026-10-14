<script lang="ts">
	import {
		ChevronDown,
		ExternalLink,
		GitMerge,
		GitPullRequest,
		GitPullRequestDraft,
		Link2,
		LoaderCircle,
		Rocket,
		Upload
	} from 'lucide-svelte';
	import Menu from '@orchardlabs/graft-ui/components/ui/Menu.svelte';
	import MenuItem from '@orchardlabs/graft-ui/components/ui/MenuItem.svelte';
	import { toasts } from '../../host/stores';
	import { getGreenhouseApp } from './app.svelte';
	import * as api from './api';
	import {
		LINK_GITHUB,
		VIEWER_ONLY,
		hostOnly,
		isLegacy,
		scopeOf,
		type MachineWorkspace
	} from './workspace.svelte';

	let { ws }: { ws: MachineWorkspace } = $props();

	const session = $derived(ws.session);
	const owner = $derived(ws.isOwner);
	const canPush = $derived(ws.canPush);
	const pushBlocked = $derived(
		!ws.canEdit ? VIEWER_ONLY : ws.githubLinked === false ? LINK_GITHUB : undefined
	);
	const pr = $derived(session?.prNumber ? session : null);
	const merged = $derived(session?.prState === 'merged');
	const open = $derived(!!pr && session?.prState !== 'merged' && session?.prState !== 'closed');

	let menuOpen = $state(false);
	let busy = $state<string | null>(null);
	const BUSY_LABEL: Record<string, string> = {
		'Create PR': 'Creating…',
		'Draft PR': 'Creating draft…',
		Push: 'Pushing…',
		Merge: 'Merging…'
	};

	async function run(label: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = label;
		try {
			await fn();
		} catch (e) {
			ws.prFailed(label, e);
		} finally {
			busy = null;
		}
	}

	function createPr(draft: boolean) {
		if (!session) return;
		return run(draft ? 'Draft PR' : 'Create PR', () => ws.createPr(draft));
	}

	function push() {
		const current = session;
		if (!current) return;
		return run('Push', async () => {
			await api.gitPush(ws.sandboxId, scopeOf(current));
			toasts.add({ title: `Pushed ${current.branch}`, color: 'success' });
			void ws.refreshChanges(current.id);
		});
	}

	function merge() {
		const current = session;
		if (!current) return;
		return run('Merge', async () => {
			await api.mergePr(ws.sandboxId, current.id);
			ws.upsert({ ...current, prState: 'merged' });
			toasts.add({ title: `Squash merged #${current.prNumber}`, color: 'success' });
		});
	}

	const app = getGreenhouseApp();

	function primary() {
		if (pr?.prUrl) {
			window.open(pr.prUrl, '_blank', 'noopener');
			return;
		}
		void createPr(false);
	}
</script>

{#if ws.canEdit && ws.githubLinked === false && !pr}
	<a
		class="gh-btn gh-btn--primary"
		href={api.LINK_GITHUB_HREF}
		title="Pushes and pull requests run with your own GitHub account"
	>
		<Link2 size={14} strokeWidth={1.75} />
		{LINK_GITHUB}
	</a>
{:else}
	<div
		class="gh-split"
		class:gh-split--primary={!pr}
		role="group"
		aria-label="Pull request"
		data-tour="pr"
	>
		<button
			type="button"
			disabled={!session || (!pr && !canPush) || !!busy}
			title={!pr ? pushBlocked : undefined}
			onclick={primary}
		>
			{#if busy}
				<span class="animate-spin inline-grid" data-motion="progress"
					><LoaderCircle size={14} strokeWidth={1.75} /></span
				>
				<span data-align="title">{BUSY_LABEL[busy] ?? 'Working…'}</span>
			{:else if merged}
				<GitMerge size={14} strokeWidth={1.75} />
				<span data-align="title">Merged #{pr?.prNumber}</span>
			{:else if pr}
				<GitPullRequest size={14} strokeWidth={1.75} />
				<span data-align="title">View PR #{pr.prNumber}</span>
				<ExternalLink size={12} strokeWidth={1.75} />
			{:else}
				<GitPullRequest size={14} strokeWidth={1.75} />
				<span data-align="title">Create PR</span>
			{/if}
		</button>
		<Menu bind:open={menuOpen} placement="bottom-end">
			{#snippet trigger(props, isOpen)}
				<button
					{...props}
					type="button"
					aria-label="More pull request actions"
					title="More pull request actions"
					aria-expanded={isOpen}
					disabled={!session}
				>
					<ChevronDown size={14} strokeWidth={1.75} />
				</button>
			{/snippet}
			{#if !pr}
				<MenuItem onclick={() => createPr(false)} disabled={!canPush} title={pushBlocked}>
					<GitPullRequest size={14} /> Create pull request
				</MenuItem>
				<MenuItem onclick={() => createPr(true)} disabled={!canPush} title={pushBlocked}>
					<GitPullRequestDraft size={14} /> Create draft pull request
				</MenuItem>
			{/if}
			<MenuItem onclick={push} disabled={!canPush} title={pushBlocked}>
				<Upload size={14} /> Push only
			</MenuItem>
			{#if open}
				<MenuItem
					onclick={merge}
					disabled={!canPush || isLegacy(session)}
					title={pushBlocked ?? 'Squash and merge on GitHub'}
				>
					<GitMerge size={14} /> Squash and merge
				</MenuItem>
			{/if}
			<div class="gh-menu-sep"></div>
			<MenuItem
				onclick={() => (app.sheet = 'preview')}
				disabled={!owner || isLegacy(session)}
				title={owner ? undefined : hostOnly('deploy previews')}
			>
				<Rocket size={14} />
				{session?.previewDeploymentId ? 'Preview deploy…' : 'Deploy preview…'}
			</MenuItem>
		</Menu>
	</div>
{/if}
