<script lang="ts">
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
			if (!response.ok) throw new Error('Could not turn it off');
			await instanceFeatures.load(true);
			await onDone();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Could not turn it off',
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
			<button class="setup-pill" disabled={saving} onclick={onDone}>Keep it on</button>
			{#if !overview.mcp.locked}
				<button class="setup-ghost" disabled={saving} onclick={turnOff}>
					{saving ? 'Turning off' : 'Turn it off'}
				</button>
			{/if}
		</div>
	{:else}
		<h2>MCP endpoint is off</h2>
		<p>AI agents cannot connect.</p>

		{#if enable}
			<div class="setup-body">
				<SettingCommand change={enable} />
			</div>
		{/if}

		<div class="setup-acts">
			<button class="setup-pill" onclick={onDone}>Continue without it</button>
		</div>
	{/if}
</section>
