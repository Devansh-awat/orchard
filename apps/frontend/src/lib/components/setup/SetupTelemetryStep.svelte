<script lang="ts">
	import { Button } from '$lib/components/ui';
	import { telemetry, toasts } from '$lib/stores';
	import {
		TELEMETRY_PITCH,
		TELEMETRY_SENT,
		TELEMETRY_NEVER,
		TELEMETRY_DOCS_URL
	} from '$lib/telemetry';
	import TelemetryPayload from '$lib/components/telemetry/TelemetryPayload.svelte';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	let saving = $state<boolean | null>(null);
	let showPayload = $state(false);

	async function answer(enabled: boolean) {
		if (saving !== null) return;
		saving = enabled;
		try {
			await telemetry.answer(enabled);
			await onDone();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't save your choice",
				color: 'error'
			});
		} finally {
			saving = null;
		}
	}
</script>

<section class="setup-step">
	<h2>Help improve Orchard</h2>
	<p>{TELEMETRY_PITCH}</p>

	<div class="setup-body">
		<ul class="tele-list">
			{#each TELEMETRY_SENT as item (item)}
				<li>{item}</li>
			{/each}
		</ul>
		<p class="tele-never">
			{TELEMETRY_NEVER}
			<a class="tele-never-link" href={TELEMETRY_DOCS_URL} target="_blank" rel="noreferrer"
				>See what is sent</a
			>
		</p>

		<div class="tele-peek">
			<Button variant="ghost" size="sm" onclick={() => (showPayload = !showPayload)}>
				{showPayload ? 'Hide the report' : 'See the exact report'}
			</Button>
		</div>
		{#if showPayload}
			<TelemetryPayload class="tele-payload" />
		{/if}
	</div>

	<div class="setup-acts">
		<Button
			variant="primary"
			size="lg"
			shape="capsule"
			loading={saving === true}
			disabled={saving === false}
			onclick={() => answer(true)}
		>
			Share anonymous reports
		</Button>
		<Button
			variant="ghost"
			size="lg"
			shape="capsule"
			loading={saving === false}
			disabled={saving === true}
			onclick={() => answer(false)}
		>
			Don't share
		</Button>
	</div>
</section>

<style>
	.tele-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0;
		padding-left: 1rem;
		list-style: disc;
		text-align: left;
		font-size: 0.78125rem;
		line-height: 1.45;
		color: var(--setup-ink-soft);
	}

	.tele-list li::marker {
		color: var(--setup-crimson);
	}

	.setup-step p.tele-never {
		max-width: none;
		margin-top: 0.9rem;
		text-align: left;
		font-size: 0.75rem;
		color: var(--setup-ink-faint);
	}

	.tele-peek {
		margin-top: 0.5rem;
	}

	.setup-body :global(.tele-payload) {
		margin-top: 0.7rem;
		padding: 0.7rem 0.8rem;
		border-radius: 0.75rem;
		border: 1px solid var(--setup-line);
		background: rgba(255, 255, 255, 0.55);
		color: var(--setup-ink);
	}
	.tele-never-link {
		color: var(--text-link);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
