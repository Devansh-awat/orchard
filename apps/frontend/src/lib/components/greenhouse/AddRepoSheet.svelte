<script lang="ts">
	import { Button, Modal } from '$lib/components/ui';
	import GitHubRepoPicker, {
		type PickedRepo
	} from '$lib/components/deployment/GitHubRepoPicker.svelte';
	import { toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);

	let picked = $state<PickedRepo | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!open) picked = null;
	});

	async function clone() {
		if (!ws?.isOwner || !picked || busy) return;
		busy = true;
		try {
			const res = await api.addRepo(ws.sandboxId, picked.url);
			toasts.add({ title: `Cloned ${res?.name ?? picked.fullName}`, color: 'success' });
			open = false;
			await ws.refreshRepos();
			await ws.refreshSessions();
		} catch (e) {
			toasts.add({
				title: 'Clone failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (!open || e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
		if (e.target instanceof Element && e.target.closest('button, a')) return;
		if (!picked) return;
		e.preventDefault();
		void clone();
	}
</script>

<svelte:window {onkeydown} />

<Modal bind:open title="Clone a repository">
	<div class="sheet">
		<GitHubRepoPicker
			autofocus
			load={!app.env.harness}
			onpick={(repo) => (picked = repo)}
			onclear={() => (picked = null)}
		/>
		<p class="where">Cloned into your home folder on {app.machine?.name ?? 'the machine'}</p>
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" disabled={!picked || busy || !ws?.isOwner} onclick={() => clone()}>
			{busy ? 'Cloning…' : 'Clone'}
		</Button>
	{/snippet}
</Modal>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.where {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-faint);
	}
</style>
