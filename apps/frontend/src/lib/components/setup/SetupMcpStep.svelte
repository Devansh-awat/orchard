<script lang="ts">
	import { Button } from '$lib/components/ui';
	import { Pending } from './pending.svelte';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import SettingCommand from './SettingCommand.svelte';
	import { settingChanges } from './setting-changes';
	import type { SetupOverview } from './setup-overview';

	let {
		overview,
		onDone
	}: {
		overview: SetupOverview;
		onDone: () => Promise<void> | void;
	} = $props();

	const enable = $derived(settingChanges(overview).mcp);

	const continuing = new Pending();

	let saving = $state(false);

	async function turnOff() {
		if (saving) return;
		saving = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-settings/mcp', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: false })
			});
			if (!response.ok) throw new Error("Couldn't turn it off");
			await instanceFeatures.load(true);
			await onDone();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't turn it off",
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	{#if overview.mcp.deployed}
		<h2>MCP endpoint</h2>
		<p>AI agents connect here to manage this instance.</p>

		<div class="setup-body">
			<div class="setup-url">{overview.mcp.url}</div>
		</div>

		<div class="setup-acts">
			<Button
				variant="primary"
				size="lg"
				shape="capsule"
				loading={continuing.active}
				disabled={saving}
				onclick={() => continuing.run(onDone)}
			>
				Keep it on
			</Button>
			{#if !overview.mcp.locked}
				<Button
					variant="ghost"
					size="lg"
					shape="capsule"
					loading={saving}
					disabled={continuing.active}
					onclick={turnOff}
				>
					Turn it off
				</Button>
			{/if}
		</div>
	{:else}
		<h2>MCP endpoint is off</h2>
		<p>AI agents can't connect.</p>

		{#if enable}
			<div class="setup-body">
				<SettingCommand change={enable} />
			</div>
		{/if}

		<div class="setup-acts">
			<Button
				variant="primary"
				size="lg"
				shape="capsule"
				loading={continuing.active}
				onclick={() => continuing.run(onDone)}
			>
				Continue without it
			</Button>
		</div>
	{/if}
</section>
