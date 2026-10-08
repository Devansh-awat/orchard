<script lang="ts">
	import { Button, Field, Input, Modal } from '$lib/components/ui';
	import { apiFetch, toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	interface Repository {
		id: number;
		full_name: string;
		private: boolean;
	}

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);

	let url = $state('');
	let busy = $state(false);
	let repositories = $state<Repository[]>([]);
	let fetched = false;

	const filter = $derived(url.trim().toLowerCase());
	const suggestions = $derived(
		filter.startsWith('https://')
			? []
			: repositories
					.filter((r) => !filter || r.full_name.toLowerCase().includes(filter))
					.slice(0, 6)
	);

	$effect(() => {
		if (!open || fetched || app.env.harness) return;
		fetched = true;
		void apiFetch('/apiv1/github/repositories')
			.then((res) => (res.ok ? res.json() : []))
			.then((data) => (repositories = Array.isArray(data) ? data : (data?.repositories ?? [])))
			.catch(() => (repositories = []));
	});

	async function clone(repoUrl = url.trim()) {
		if (!ws || !repoUrl || busy) return;
		busy = true;
		try {
			const res = await api.addRepo(ws.sandboxId, repoUrl);
			toasts.add({ title: `Cloned ${res?.name ?? 'repository'}`, color: 'success' });
			url = '';
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
</script>

<Modal bind:open title="Clone a repository" size="sm">
	<div class="form">
		<Field
			label="Repository"
			hint="Cloned into your home folder on {app.machine?.name ?? 'the machine'}"
			for="gh-clone"
		>
			<Input
				id="gh-clone"
				bind:value={url}
				placeholder="https://github.com/you/repo or search"
				autocomplete="off"
				onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && clone()}
			/>
		</Field>
		{#if suggestions.length > 0}
			<div class="list">
				{#each suggestions as r (r.id)}
					<button
						type="button"
						class="pick"
						disabled={busy}
						onclick={() => clone(`https://github.com/${r.full_name}`)}
					>
						<span>{r.full_name}</span>
						{#if r.private}<span class="priv">Private</span>{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button
			variant="primary"
			disabled={!url.trim().startsWith('https://') || busy}
			onclick={() => clone()}
		>
			{busy ? 'Cloning…' : 'Clone'}
		</Button>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.list {
		display: flex;
		flex-direction: column;
	}

	.pick {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 2rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-xs);
		font-size: var(--text-footnote);
		text-align: left;
	}

	.pick:hover:not(:disabled) {
		background: var(--bg-hover);
	}

	.priv {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
</style>
