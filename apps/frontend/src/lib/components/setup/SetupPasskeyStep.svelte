<script lang="ts">
	import { KeyRound, Check, ShieldCheck } from 'lucide-svelte';
	import { Alert, Button, SectionCard } from '$lib/components/ui';
	import { toasts } from '$lib/stores';
	import { springPop, motionStagger } from '$lib/utils/motion.svelte';
	import {
		registerPasskey,
		passkeysSupported,
		secureContextWarning,
		passkeyErrorMessage
	} from '$lib/utils/passkey';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	let working = $state(false);
	let added = $state(false);
	let error = $state<string | null>(null);

	const warning = $derived(secureContextWarning());
	const supported = $derived(passkeysSupported());

	async function add() {
		if (working) return;
		working = true;
		error = null;
		try {
			await registerPasskey('This device');
			added = true;
			toasts.add({ title: 'Passkey added', color: 'success' });
			setTimeout(() => void onDone(), 700);
		} catch (err) {
			error = passkeyErrorMessage(err);
		} finally {
			working = false;
		}
	}
</script>

<div class="step" {@attach motionStagger({ index: 0 })}>
	<SectionCard
		title="This instance is yours"
		description="Add a passkey so you can sign back in. Email is not set up yet, so this is your only way back to this account."
	>
		{#if added}
			<div class="done" {@attach springPop(() => added)}>
				<div class="done-mark"><Check size={18} strokeWidth={3} /></div>
				<div>
					<p class="done-title">Passkey added</p>
					<p class="done-sub">Your fingerprint or face signs you in from now on.</p>
				</div>
			</div>
		{:else}
			{#if warning}
				<Alert tone="warning" title="Not a secure origin">
					{warning} Finish setting up TLS first, then reload this page.
				</Alert>
			{:else if !supported}
				<Alert tone="warning" title="No passkey support">
					This browser cannot create a passkey. Try a current Chrome, Safari or Firefox.
				</Alert>
			{/if}

			{#if error}
				<Alert tone="error" title="Could not add the passkey">{error}</Alert>
			{/if}

			<ul class="why">
				<li><ShieldCheck size={14} /> Nothing to remember and nothing to leak</li>
				<li><KeyRound size={14} /> Works with no email server configured</li>
			</ul>

			<div class="actions">
				<Button
					variant="primary"
					loading={working}
					disabled={!supported || !!warning}
					onclick={add}
				>
					<KeyRound size={15} />
					Add a passkey
				</Button>
			</div>
		{/if}
	</SectionCard>
</div>

<style>
	.step {
		display: flex;
		flex-direction: column;
	}

	.why {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0.25rem 0 0;
		padding: 0;
		list-style: none;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.why li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 1.25rem;
	}

	.done {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.done-mark {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 999px;
		background: var(--status-success);
		color: var(--bg-surface);
		flex-shrink: 0;
	}

	.done-title {
		margin: 0;
		font-weight: 600;
		color: var(--text-fg);
	}

	.done-sub {
		margin: 0.125rem 0 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
