<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { apiFetch } from '$lib/stores';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	type CertState =
		| 'ready'
		| 'issuing'
		| 'failed'
		| 'rateLimited'
		| 'unknown'
		| 'unconfigured'
		| 'perHost';
	type Certificate = { state: CertState; host: string | null; message: string | null };

	const POLL_MS = 3000;
	const DEADLINE_MS = 90_000;

	let cert = $state<Certificate>({ state: 'issuing', host: null, message: null });
	let waiting = $state(true);
	let timedOut = $state(false);
	let stopped = false;
	let started = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const COPY: Record<Exclude<CertState, 'ready'>, { title: string; note: string }> = {
		issuing: {
			title: 'Still issuing',
			note: 'This keeps running in the background. It will show up in your checklist when it lands.'
		},
		failed: {
			title: 'Certificate did not issue',
			note: 'Point the domain at this cluster, then try again. Orchard works without it.'
		},
		rateLimited: {
			title: "Let's Encrypt rate limit",
			note: 'Nothing to fix. The limit rolls off and the certificate issues on its own.'
		},
		unknown: {
			title: 'No certificate automation',
			note: 'Orchard runs fine without it. Terminate TLS wherever you already do.'
		},
		unconfigured: {
			title: 'No app domain set',
			note: 'Set APP_DOMAIN to hand out generated URLs. Orchard works without it.'
		},
		perHost: {
			title: 'Certificates issue per app',
			note: 'No wildcard is configured, so each generated URL gets its own certificate. That is the default and nothing here is waiting on you.'
		}
	};

	const title = $derived(
		waiting ? 'Issuing your certificate' : COPY[cert.state as Exclude<CertState, 'ready'>].title
	);
	const note = $derived(waiting ? null : COPY[cert.state as Exclude<CertState, 'ready'>].note);
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

		if (cert.state === 'ready') {
			await onDone();
			return;
		}
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
	{#if cert.message}
		<p class="status">{cert.message}</p>
	{:else if waiting}
		<p class="status">Waiting on cert-manager{cert.host ? ` for ${cert.host}` : ''}</p>
	{/if}
	{#if note}
		<p class="setup-note">{note}</p>
	{/if}

	{#if waiting}
		<div class="setup-body">
			<div class="setup-pulse" data-motion="progress"><i></i><i></i><i></i></div>
		</div>
	{:else}
		<div class="setup-acts">
			<button class="setup-pill" onclick={onDone}>Continue</button>
			{#if canRetry}
				<button class="setup-ghost" onclick={watch}>Try again</button>
			{/if}
		</div>
	{/if}
</section>
