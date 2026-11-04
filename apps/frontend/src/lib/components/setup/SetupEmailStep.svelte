<script lang="ts">
	import { apiFetch, toasts, user } from '$lib/stores';

	let {
		onDone,
		onSkip
	}: {
		onDone: () => Promise<void> | void;
		onSkip: () => Promise<void> | void;
	} = $props();

	let host = $state('');
	let port = $state('');
	let username = $state('');
	let password = $state('');
	let from = $state('');
	let testing = $state(false);
	let saving = $state(false);
	let passed = $state(false);
	let failure = $state<string | null>(null);

	const to = $derived(($user as { email?: string } | null)?.email ?? '');
	const values = $derived({
		host: host.trim(),
		port: port.trim(),
		user: username.trim(),
		pass: password,
		from: from.trim()
	});

	$effect(() => {
		void values;
		passed = false;
		failure = null;
	});

	async function test() {
		testing = true;
		const sent = values;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/email/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...sent, to })
			});
			const body = await response.json().catch(() => ({}));
			if (response.ok && body.ok) {
				passed = true;
				failure = null;
			} else {
				passed = false;
				failure = body.message || "Couldn't send the test email.";
			}
		} catch {
			passed = false;
			failure = "Couldn't send the test email.";
		} finally {
			testing = false;
		}
	}

	async function save() {
		saving = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/email', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(values)
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || 'Could not save');
			}
			await onDone();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Could not save', color: 'error' });
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Set up email</h2>
	<p>Optional. Without it, there are no email sign-in codes, and invitations are links you copy.</p>

	<div class="setup-body setup-grid">
		<input
			class="wide"
			aria-label="SMTP host"
			placeholder="SMTP host"
			autocomplete="off"
			spellcheck="false"
			bind:value={host}
		/>
		<input
			aria-label="Port"
			placeholder="Port (587)"
			inputmode="numeric"
			autocomplete="off"
			bind:value={port}
		/>
		<input
			aria-label="Username"
			placeholder="Username"
			autocomplete="off"
			spellcheck="false"
			bind:value={username}
		/>
		<input
			class="full"
			aria-label="Password"
			placeholder="Password"
			type="password"
			autocomplete="new-password"
			bind:value={password}
		/>
		<input
			class="full"
			aria-label="From address"
			placeholder="From address"
			type="email"
			autocomplete="off"
			spellcheck="false"
			bind:value={from}
		/>
	</div>

	{#if failure}
		<p class="status" role="alert">{failure}</p>
	{:else if passed}
		<p class="status" role="status">Test email sent to {to}.</p>
	{/if}

	<div class="setup-acts">
		{#if passed}
			<button class="setup-pill" disabled={saving} onclick={save}>
				{saving ? 'Saving' : 'Save and continue'}
			</button>
		{:else}
			<button class="setup-pill" disabled={testing || !host.trim()} onclick={test}>
				{testing ? 'Sending' : 'Send a test email'}
			</button>
		{/if}
		{#if failure}
			<button class="setup-ghost" disabled={saving} onclick={save}>Save anyway</button>
		{/if}
		<button class="setup-ghost" onclick={onSkip}>Skip for now</button>
	</div>
</section>

<style>
	.setup-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.setup-grid .wide,
	.setup-grid .full {
		grid-column: 1 / -1;
	}
</style>
