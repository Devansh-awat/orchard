<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ShieldCheck, Loader2 } from 'lucide-svelte';
	import { user, isSignedIn, isSuperAdmin, apiFetch, toasts } from '$lib/stores';
	import { Alert, Button, Field, Input, SectionCard } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';

	type State = 'checking' | 'ready' | 'claimed' | 'unavailable';

	let state = $state<State>('checking');
	let token = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);

	onMount(async () => {
		if (!$isSignedIn) {
			goto(`/?next=${encodeURIComponent($page.url.pathname + $page.url.search)}`, {
				replaceState: true
			});
			return;
		}

		token = $page.url.searchParams.get('token') ?? '';

		if ($isSuperAdmin) {
			state = 'claimed';
			return;
		}

		try {
			const response = await apiFetch('/apiv1/setup/status');
			const data = response.ok ? await response.json() : { claimable: false };
			state = data.claimable ? 'ready' : 'unavailable';
		} catch {
			state = 'unavailable';
		}
	});

	async function claim(event: SubmitEvent) {
		event.preventDefault();
		if (!token.trim() || submitting) return;

		submitting = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/setup/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: token.trim() })
			});

			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body.message || 'That claim token is not valid');
			}

			await user.fetchUser();
			state = 'claimed';
			toasts.add({ title: 'You are now the superadmin of this instance', color: 'success' });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not claim this instance';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head><title>Claim this instance</title></svelte:head>

<div class="claim-page">
	{#if state === 'checking'}
		<div class="claim-loading" data-motion="progress">
			<Loader2 size={20} class="animate-spin" />
		</div>
	{:else}
		<div class="claim-card" {@attach motionStagger({ index: 0 })}>
			<SectionCard
				title="Claim this instance"
				description="The first person to redeem the setup token becomes the superadmin."
			>
				{#if state === 'claimed'}
					<Alert tone="success" title="This instance is yours">
						You can manage users, nodes and instance settings from the admin area.
					</Alert>
					<div class="claim-actions">
						<Button variant="primary" href="/admin">Go to admin</Button>
					</div>
				{:else if state === 'unavailable'}
					<Alert tone="info" title="Nothing to claim">
						This instance already has a superadmin. Ask them for access.
					</Alert>
					<div class="claim-actions">
						<Button href="/">Back to dashboard</Button>
					</div>
				{:else}
					<form class="claim-form" onsubmit={claim}>
						<Field
							label="Setup token"
							hint="Printed in the server logs on first boot."
							{error}
							for="claim-token"
						>
							<Input
								id="claim-token"
								bind:value={token}
								error={Boolean(error)}
								placeholder="Paste your setup token"
								autocomplete="off"
								spellcheck="false"
							/>
						</Field>
						<div class="claim-actions">
							<Button type="submit" variant="primary" loading={submitting} disabled={!token.trim()}>
								<ShieldCheck size={15} />
								Claim instance
							</Button>
						</div>
					</form>
				{/if}
			</SectionCard>
		</div>
	{/if}
</div>

<style>
	.claim-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		padding: 2rem 1rem;
	}

	.claim-card {
		width: 100%;
		max-width: 27rem;
	}

	.claim-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}

	.claim-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.claim-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 1rem;
	}
</style>
