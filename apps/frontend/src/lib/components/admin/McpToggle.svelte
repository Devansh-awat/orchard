<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import { SectionCard, ToggleRow, Badge } from '$lib/components/ui';

	interface State {
		enabled: boolean;
		dbValue: boolean;
		envOverride: boolean | null;
	}

	let state = $state<State | null>(null);
	let saving = $state(false);

	async function load() {
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/mcp');
			if (!res.ok) return;
			state = await res.json();
		} catch {
			state = null;
		}
	}

	async function toggle() {
		if (!state || state.envOverride !== null) return;
		saving = true;
		const next = !state.dbValue;
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/mcp', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			if (!res.ok) throw new Error('Failed to save');
			state = await res.json();
			await instanceFeatures.load(true);
			toasts.add({ title: next ? 'MCP on' : 'MCP off', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

{#if state}
	<SectionCard
		title="Model Context Protocol"
		description="Lets AI assistants manage apps, databases and networking through the same API the dashboard uses."
	>
		{#if state.envOverride !== null}
			<div class="mcp-locked">
				<Badge tone="neutral">env override</Badge>
				<span>
					Pinned to <span class="font-mono">{state.envOverride ? 'on' : 'off'}</span> by the
					<span class="font-mono">MCP_ENABLED</span> env var, which the chart sets when
					<span class="font-mono">mcp.enabled</span> is false. Nothing is serving MCP until that is turned
					back on.
				</span>
			</div>
		{:else}
			<ToggleRow
				checked={state.dbValue}
				label="Accept MCP connections"
				hint="Off refuses every request to the MCP server and hides the setup instructions."
				disabled={saving}
				onchange={toggle}
			/>
		{/if}
	</SectionCard>
{/if}

<style>
	.mcp-locked {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
