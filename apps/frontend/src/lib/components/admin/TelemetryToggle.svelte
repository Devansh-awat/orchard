<script lang="ts">
	import { onMount } from 'svelte';
	import { telemetry, toasts } from '$lib/stores';
	import {
		Badge,
		Disclosure,
		SectionCard,
		SettingRow,
		SettingsList,
		ToggleRow
	} from '$lib/components/ui';
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
			void telemetry.reload();
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
		<div class="report">
			<SettingsList>
				{#if $telemetry.envOverride !== null}
					<SettingRow label="Share anonymous reports">
						{#snippet hint()}
							Pinned to <code>{$telemetry?.envOverride ? 'on' : 'off'}</code> by the
							<code>ORCHARD_TELEMETRY</code> environment variable. Unset it to control this here.
						{/snippet}
						<Badge>env override</Badge>
					</SettingRow>
				{:else}
					<ToggleRow
						checked={$telemetry.enabled}
						label="Share anonymous reports"
						hint={$telemetry.consent === null ? 'Not decided yet, so nothing is sent.' : undefined}
						disabled={saving}
						onchange={toggle}
					/>
				{/if}
			</SettingsList>

			<ul class="sent">
				{#each TELEMETRY_SENT as item (item)}
					<li>{item}</li>
				{/each}
			</ul>
			<p class="never">{TELEMETRY_NEVER}</p>

			<Disclosure title="See the exact report" bind:open={showPayload}>
				{#if showPayload}
					<div class="payload">
						<TelemetryPayload />
					</div>
				{/if}
			</Disclosure>
		</div>
	</SectionCard>
{/if}

<style>
	.report {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.sent {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding-left: var(--space-4);
		list-style: disc;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.never {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.payload {
		padding: var(--space-3);
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		color: var(--text-default);
	}
</style>
