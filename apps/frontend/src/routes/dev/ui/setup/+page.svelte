<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui';
	import { apiFetch } from '$lib/stores';
	import SetupCard from '$lib/components/setup/SetupCard.svelte';
	import SetupPasskeyStep from '$lib/components/setup/SetupPasskeyStep.svelte';
	import SetupOrgStep from '$lib/components/setup/SetupOrgStep.svelte';
	import SetupGithubStep from '$lib/components/setup/SetupGithubStep.svelte';
	import SetupStorageStep from '$lib/components/setup/SetupStorageStep.svelte';
	import SetupLimitsStep from '$lib/components/setup/SetupLimitsStep.svelte';
	import SetupNetworkStep from '$lib/components/setup/SetupNetworkStep.svelte';
	import SetupMcpStep from '$lib/components/setup/SetupMcpStep.svelte';
	import SetupEmailStep from '$lib/components/setup/SetupEmailStep.svelte';
	import SetupCertificateStep from '$lib/components/setup/SetupCertificateStep.svelte';
	import SetupTelemetryStep from '$lib/components/setup/SetupTelemetryStep.svelte';
	import SetupDoneStep from '$lib/components/setup/SetupDoneStep.svelte';
	import type { SetupOverview } from '$lib/components/setup/setup-overview';

	let overview = $state<SetupOverview | null>(null);
	const mcpOff = $derived(
		overview ? { ...overview, mcp: { ...overview.mcp, deployed: false, enabled: false } } : null
	);

	const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 1500));

	onMount(async () => {
		const response = await apiFetch('/apiv1/setup/overview');
		if (response.ok) overview = await response.json();
	});

	async function walk() {
		await apiFetch('/apiv1/auth/me', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ setupCompleted: false })
		});
		await goto('/setup');
	}
</script>

<div class="sheet">
	<header>
		<h1>Setup flow</h1>
		<Button variant="primary" onclick={walk}>Walk the real flow</Button>
	</header>

	<div class="grid">
		<figure>
			<figcaption>1. Passkey or password</figcaption>
			<SetupCard total={8} index={0}><SetupPasskeyStep onDone={wait} /></SetupCard>
		</figure>
		<figure>
			<figcaption>2. Organization</figcaption>
			<SetupCard total={8} index={1}><SetupOrgStep onDone={wait} onSkip={wait} /></SetupCard>
		</figure>
		<figure>
			<figcaption>3. GitHub</figcaption>
			<SetupCard total={8} index={2}><SetupGithubStep onDone={wait} onSkip={wait} /></SetupCard>
		</figure>
		<figure>
			<figcaption>4. S3 storage</figcaption>
			<SetupCard total={8} index={3}><SetupStorageStep onDone={wait} onSkip={wait} /></SetupCard>
		</figure>
		<figure>
			<figcaption>5. Resource limits</figcaption>
			<SetupCard total={8} index={4}><SetupLimitsStep onDone={wait} /></SetupCard>
		</figure>
		{#if overview && mcpOff}
			<figure>
				<figcaption>6. Network, Helm installs only</figcaption>
				<SetupCard total={8} index={5}>
					<SetupNetworkStep {overview} onDone={wait} onSkip={wait} />
				</SetupCard>
			</figure>
			<figure>
				<figcaption>7. MCP on, Helm installs only</figcaption>
				<SetupCard total={8} index={5}><SetupMcpStep {overview} onDone={wait} /></SetupCard>
			</figure>
			<figure>
				<figcaption>7. MCP off, Helm installs only</figcaption>
				<SetupCard total={8} index={5}><SetupMcpStep overview={mcpOff} onDone={wait} /></SetupCard>
			</figure>
		{/if}
		<figure>
			<figcaption>8. Email</figcaption>
			<SetupCard total={8} index={6}><SetupEmailStep onDone={wait} onSkip={wait} /></SetupCard>
		</figure>
		<figure>
			<figcaption>9. Certificate</figcaption>
			<SetupCard total={8} index={6}><SetupCertificateStep onDone={wait} /></SetupCard>
		</figure>
		<figure>
			<figcaption>10. Usage reports</figcaption>
			<SetupCard total={8} index={7}><SetupTelemetryStep onDone={wait} /></SetupCard>
		</figure>
		{#if overview}
			<figure>
				<figcaption>11. Done</figcaption>
				<SetupCard total={8} index={8}><SetupDoneStep {overview} onDone={wait} /></SetupCard>
			</figure>
		{/if}
	</div>
</div>

<style>
	.sheet {
		height: 100dvh;
		overflow-y: auto;
		padding: 2rem;
		background: var(--setup-field);
		color: var(--setup-ink);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 2rem;
	}

	h1 {
		font-size: var(--text-title-2);
		font-weight: var(--weight-semibold);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(27rem, 1fr));
		gap: 2rem;
		align-items: start;
	}

	figure {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		margin: 0;
	}

	figcaption {
		font-size: var(--text-callout);
		color: var(--setup-ink-soft);
	}
</style>
