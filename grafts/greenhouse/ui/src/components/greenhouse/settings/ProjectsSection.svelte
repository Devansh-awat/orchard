<script lang="ts">
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Button } from '@orchardlabs/graft-ui';
	import { organizations, toasts } from '../../../host/stores';
	import type { Sandbox } from '../../../lib/types/sandbox';
	import { getGreenhouseApp } from '../app.svelte';
	import ProjectLinks, { ProjectLinkStore } from '../ProjectLinks.svelte';
	import type { MachineWorkspace } from '../workspace.svelte';
	import Block from './Block.svelte';

	let { machine, ws }: { machine: Sandbox; ws: MachineWorkspace } = $props();

	const app = getGreenhouseApp();
	const store = new ProjectLinkStore();
	const owner = $derived(ws.isOwner);

	$effect(() => {
		const id = ws.sandboxId;
		const org = machine.organizationId ?? app.organizationId ?? null;
		const canAttach = owner;
		untrack(() => {
			store.resetPick();
			void store.load(id);
			if (!canAttach || !org) return;
			void store.loadProjects(org, {
				userId: app.self?.id ?? null,
				orgRole: get(organizations).find((o) => o.id === org)?.myRole ?? null,
				superAdmin: app.superAdmin
			});
		});
	});

	async function attach() {
		const link = await store.attach(ws.sandboxId);
		if (!link) return;
		toasts.add({
			title: `Attached ${link.project.name}`,
			description: link.envFile,
			color: 'success'
		});
	}
</script>

<Block>
	<ProjectLinks {store} mode="list" />
</Block>

{#if owner}
	<Block>
		<ProjectLinks {store} mode="attach" />
		<div class="actions">
			<Button
				variant="secondary"
				size="sm"
				loading={store.busy === 'attach'}
				disabled={!store.projectId || !!store.busy}
				onclick={attach}
			>
				Attach
			</Button>
		</div>
	</Block>
{/if}

<style>
	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
