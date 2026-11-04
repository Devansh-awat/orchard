<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { apiFetch } from '$lib/stores';
	import type { SetupCertificate } from './setup-overview';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	const POLL_MS = 3000;
	const DEADLINE_MS = 90_000;

	let cert = $state<SetupCertificate>({ state: 'issuing', host: null, message: null });
	let waiting = $state(true);
	let timedOut = $state(false);
	let stopped = false;
	let started = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const COPY: Record<SetupCertificate['state'], { title: string; note: string }> = {
		ready: {
			title: 'Certificate issued',
			note: 'It renews automatically.'
		},
		issuing: {
			title: 'Still issuing',
			note: 'cert-manager keeps trying in the background. If it fails, check that DNS points here and that ports 80 and 443 are open.'
		},
		failed: {
			title: "Certificate didn't issue",
			note: "Check that DNS points here and that ports 80 and 443 are open, including in your cloud provider's firewall. It retries automatically, first after about an hour. See DNS status in Instance admin, under Networking."
		},
		rateLimited: {
			title: "Let's Encrypt rate limit",
			note: 'You have nothing to fix. The certificate issues when the limit resets. Your own domain avoids the limit shared on sslip.io.'
		},
		unknown: {
			title: 'Certificate status unknown',
			note: "Orchard can't read cert-manager from here. If your browser warns about this page, the certificate hasn't issued."
		},
		unconfigured: {
			title: 'No app domain set',
			note: 'Apps get no generated URL until you set one in Instance admin.'
		},
		perHost: {
			title: 'Certificates issue per app',
			note: "Each generated URL gets its own certificate. You don't need to do anything."
		},
		external: {
			title: 'No certificate to issue here',
			note: 'TLS is handled outside this instance.'
		}
	};

	const title = $derived(waiting ? 'Issuing your certificate' : COPY[cert.state].title);
	const note = $derived(waiting ? null : COPY[cert.state].note);
	const canRetry = $derived(!waiting && (cert.state === 'failed' || timedOut));

	async function poll() {
		if (stopped) return;
		try {
			const response = await apiFetch('/apiv1/setup/certificate');
			if (response.ok) cert = await response.json();
		} catch {
			cert = { ...cert, state: 'unknown' };
		}
		if (stopped) return;

		if (cert.state !== 'issuing') {
			waiting = false;
			return;
		}
		if (Date.now() - started > DEADLINE_MS) {
			timedOut = true;
			waiting = false;
			return;
		}
		timer = setTimeout(poll, POLL_MS);
	}

	function watch() {
		waiting = true;
		timedOut = false;
		started = Date.now();
		poll();
	}

	onMount(watch);
	onDestroy(() => {
		stopped = true;
		clearTimeout(timer);
	});
</script>

<section class="setup-step">
	<h2>{title}</h2>
	{#if cert.message && cert.state !== 'ready'}
		<p class="status">{cert.message}</p>
	{:else if cert.host}
		<p class="status">{cert.host}</p>
	{:else if waiting}
		<p class="status">Waiting on cert-manager</p>
	{/if}
	{#if note}
		<p class="setup-note">{note}</p>
	{/if}

	{#if waiting}
		<div class="setup-body">
			<div class="setup-pulse" data-motion="progress"><i></i><i></i><i></i></div>
		</div>
	{/if}

	<div class="setup-acts">
		{#if waiting}
			<button class="setup-ghost" onclick={onDone}>Continue while it retries</button>
		{:else}
			<button class="setup-pill" onclick={onDone}>Continue</button>
			{#if canRetry}
				<button class="setup-ghost" onclick={watch}>Check again</button>
			{/if}
		{/if}
	</div>
</section>
