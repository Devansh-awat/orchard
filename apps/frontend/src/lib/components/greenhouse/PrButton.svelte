<script lang="ts">
	import {
		ChevronDown,
		ExternalLink,
		GitMerge,
		GitPullRequest,
		GitPullRequestDraft,
		Rocket,
		Upload
	} from 'lucide-svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import * as api from './api';
	import { OWNER_ONLY, isLegacy, scopeOf, type MachineWorkspace } from './workspace.svelte';

	let { ws }: { ws: MachineWorkspace } = $props();

	const session = $derived(ws.session);
	const owner = $derived(ws.isOwner);
	const pr = $derived(session?.prNumber ? session : null);
	const merged = $derived(session?.prState === 'merged');
	const open = $derived(!!pr && session?.prState !== 'merged' && session?.prState !== 'closed');

	let menuOpen = $state(false);
	let busy = $state<string | null>(null);

	async function run(label: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = label;
		try {
			await fn();
		} catch (e) {
			toasts.add({
				title: `${label} failed`,
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}

	function createPr(draft: boolean) {
		const current = session;
		if (!current) return;
		return run(draft ? 'Draft PR' : 'Create PR', async () => {
			const res = await api.createPr(ws.sandboxId, scopeOf(current), {
				title: current.title,
				draft
			});
			const number = res.number ?? Number(res.url.split('/').pop());
			ws.upsert({ ...current, prUrl: res.url, prNumber: number || null, prState: 'open' });
			toasts.add({
				title: draft ? 'Draft pull request opened' : 'Pull request opened',
				color: 'success',
				action: { label: 'View', onClick: () => window.open(res.url, '_blank', 'noopener') }
			});
		});
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

	function preview() {
		const current = session;
		if (!current) return;
		return run('Preview deploy', async () => {
			const res = await apiFetch(
				`/apiv1/sandboxes/${ws.sandboxId}/sessions/${current.id}/preview-deploy`,
				{ method: 'POST' }
			);
			if (res.status === 404) {
				toasts.add({ title: 'Preview deploys are not available yet', color: 'info' });
				return;
			}
			if (!res.ok) throw new Error('The server refused the deploy');
			toasts.add({ title: 'Preview deploy started', color: 'success' });
		});
	}

	function primary() {
		if (pr?.prUrl) {
			window.open(pr.prUrl, '_blank', 'noopener');
			return;
		}
		void createPr(false);
	}
</script>

<div class="gh-split" class:gh-split--primary={!pr} role="group" aria-label="Pull request">
	<button
		type="button"
		disabled={!session || (!pr && !owner) || !!busy}
		title={!pr && !owner ? OWNER_ONLY : undefined}
		onclick={primary}
	>
		{#if merged}
			<GitMerge size={14} strokeWidth={1.75} /> Merged #{pr?.prNumber}
		{:else if pr}
			<GitPullRequest size={14} strokeWidth={1.75} /> View PR #{pr.prNumber}
			<ExternalLink size={12} strokeWidth={1.75} />
		{:else}
			<GitPullRequest size={14} strokeWidth={1.75} />
			{busy === 'Create PR' ? 'Creating…' : 'Create PR'}
		{/if}
	</button>
	<Menu bind:open={menuOpen} placement="bottom-end">
		{#snippet trigger(props, isOpen)}
			<button
				{...props}
				type="button"
				aria-label="More pull request actions"
				aria-expanded={isOpen}
				disabled={!session}
			>
				<ChevronDown size={14} strokeWidth={1.75} />
			</button>
		{/snippet}
		{#if !pr}
			<MenuItem
				onclick={() => createPr(false)}
				disabled={!owner}
				title={owner ? undefined : OWNER_ONLY}
			>
				<GitPullRequest size={14} /> Create pull request
			</MenuItem>
			<MenuItem
				onclick={() => createPr(true)}
				disabled={!owner}
				title={owner ? undefined : OWNER_ONLY}
			>
				<GitPullRequestDraft size={14} /> Create draft pull request
			</MenuItem>
		{/if}
		<MenuItem onclick={push} disabled={!owner} title={owner ? undefined : OWNER_ONLY}>
			<Upload size={14} /> Push only
		</MenuItem>
		{#if open}
			<MenuItem
				onclick={merge}
				disabled={!owner || isLegacy(session)}
				title={owner ? 'Squash and merge on GitHub' : OWNER_ONLY}
			>
				<GitMerge size={14} /> Squash and merge
			</MenuItem>
		{/if}
		<div class="gh-menu-sep"></div>
		<MenuItem onclick={preview} disabled={!owner} title={owner ? undefined : OWNER_ONLY}>
			<Rocket size={14} /> Deploy preview
		</MenuItem>
	</Menu>
</div>
