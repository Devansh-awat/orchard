<script lang="ts">
	import { onMount } from 'svelte';
	import { telemetry, toasts } from '$lib/stores';
	import { SectionCard, ToggleRow, Badge } from '$lib/components/ui';
	import { TELEMETRY_SENT, TELEMETRY_NEVER } from '$lib/telemetry';
	import TelemetryPayload from '$lib/components/telemetry/TelemetryPayload.svelte';

	let saving = $state(false);
	let showPayload = $state(false);

	async function toggle() {
		if (!$telemetry || $telemetry.envOverride !== null) return;
		saving = true;
		const next = !$telemetry.enabled;
		try {
			await telemetry.answer(next);
			toasts.add({
				title: next ? 'Sharing anonymous reports' : 'No longer sharing reports',
				color: 'success'
			});
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(() => {
		void telemetry.reload();
	});
</script>

{#if $telemetry}
	<SectionCard
		title="Anonymous usage reports"
		description="A short daily report to the Orchard team about which features are in use and which crashes to fix first."
	>
		{#if $telemetry.envOverride !== null}
			<div class="tt-locked">
				<Badge tone="neutral">env override</Badge>
				<span>
					Pinned to <span class="font-mono">{$telemetry.envOverride ? 'on' : 'off'}</span> by the
					<span class="font-mono">ORCHARD_TELEMETRY</span> env var. Unset it to control this here.
				</span>
			</div>
		{:else}
			<ToggleRow
				checked={$telemetry.enabled}
				label="Share anonymous reports"
				hint={$telemetry.consent === null ? 'Not decided yet, so nothing is sent.' : undefined}
				disabled={saving}
				onchange={toggle}
			/>
		{/if}

		<ul class="tt-list">
			{#each TELEMETRY_SENT as item (item)}
				<li>{item}</li>
			{/each}
		</ul>
		<p class="tt-never">{TELEMETRY_NEVER}</p>

		<button class="tt-peek" onclick={() => (showPayload = !showPayload)}>
			{showPayload ? 'Hide the report' : 'See the exact report'}
		</button>
		{#if showPayload}
			<TelemetryPayload class="tt-payload" />
		{/if}
	</SectionCard>
{/if}

<style>
	.tt-locked {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.tt-list {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 1rem 0 0;
		padding-left: 1.1rem;
		list-style: disc;
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--text-muted);
	}

	.tt-never {
		margin-top: 0.75rem;
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--text-faint);
	}

	.tt-peek {
		margin-top: 0.75rem;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		font: inherit;
		font-size: var(--text-caption);
		font-weight: 500;
		color: var(--text-link);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.tt-peek + :global(.tt-payload) {
		margin-top: 0.625rem;
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-sunken);
		color: var(--text-default);
	}
</style>
