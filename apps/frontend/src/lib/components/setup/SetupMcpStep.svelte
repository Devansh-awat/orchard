<script lang="ts">
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import { dashboardHost, parentDomain, type SetupOverview } from './setup-overview';

	let {
		overview,
		onDone
	}: {
		overview: SetupOverview;
		onDone: () => Promise<void> | void;
	} = $props();

	const host = dashboardHost(overview);
	const suggested = host ? `mcp.${parentDomain(host)}` : 'mcp.example.com';

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
		<p>
			AI agents cannot connect. Pick any hostname, and run one of these where you deploy Orchard.
		</p>

		<div class="setup-body setup-commands">
			<code>sudo orchardctl mcp enable {suggested} --apply</code>
			<code>helm upgrade orchard ... --set mcp.enabled=true --set mcp.ingress.host={suggested}</code
			>
		</div>

		<div class="setup-acts">
			<button class="setup-pill" onclick={onDone}>Continue without it</button>
		</div>
	{/if}
</section>
