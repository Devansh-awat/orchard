<script lang="ts">
	import { toasts } from '$lib/stores';
	import {
		registerPasskey,
		passkeysSupported,
		secureContextWarning,
		passkeyErrorMessage
	} from '$lib/utils/passkey';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	let working = $state(false);
	let error = $state<string | null>(null);

	const warning = $derived(secureContextWarning());
	const supported = $derived(passkeysSupported());
	const blocked = $derived(!supported || !!warning);

	async function add() {
		if (working) return;
		working = true;
		error = null;
		try {
			await registerPasskey('This device');
			toasts.add({ title: 'Passkey added', color: 'success' });
			await onDone();
		} catch (err) {
			error = passkeyErrorMessage(err);
		} finally {
			working = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Create your passkey</h2>
	{#if warning}
		<p>{warning} Finish setting up TLS first, then reload this page.</p>
	{:else if !supported}
		<p>This browser cannot create a passkey. Try a current Chrome, Safari or Firefox.</p>
	{:else if error}
		<p>{error}</p>
	{:else}
		<p>It stays on this device. Nothing to remember, nothing to leak.</p>
	{/if}

	<div class="setup-acts">
		<button class="setup-pill" disabled={blocked || working} onclick={add}>
			{working ? 'Waiting for your device' : 'Create passkey'}
		</button>
	</div>
</section>
