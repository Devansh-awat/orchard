<script lang="ts">
	import { apiFetch, toasts, user } from '$lib/stores';
	import { Alert, SectionCard, SettingsList, ToggleRow } from '$lib/components/ui';

	let { passkeyCount }: { passkeyCount: number } = $props();

	let saving = $state(false);
	let passkeyOnly = $state(false);
	$effect(() => {
		passkeyOnly = Boolean($user?.passkeyOnly);
	});

	const owner = $derived($user?.emailDomainOwner ?? null);

	async function toggle(next: boolean) {
		saving = true;
		try {
			const res = await apiFetch('/apiv1/auth/me', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ passkeyOnly: next })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || "Couldn't change how you sign in");
			await user.fetchUser();
			toasts.add({
				title: next ? 'Email codes turned off' : 'Email codes turned on',
				color: 'success'
			});
		} catch (e) {
			passkeyOnly = !next;
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't change how you sign in",
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}
</script>

<SectionCard
	title="Email codes"
	description="Whoever can read your inbox can sign in with an email code. Turn codes off and only your passkeys sign you in."
>
	{#if owner}
		<div class="notice">
			<Alert tone="warning" title="{owner.organization} controls {owner.domain}">
				{owner.organization} verified the domain of your email, so it can read that mailbox and sign in
				to this account with a code. If this account is personal, move it to a personal email or turn
				email codes off.
			</Alert>
		</div>
	{/if}
	<SettingsList>
		<ToggleRow
			bind:checked={passkeyOnly}
			label="Sign in with a passkey only"
			hint={passkeyCount === 0
				? 'Add a passkey first.'
				: 'If you lose every passkey, your Orchard admin has to recover the account.'}
			disabled={saving || (passkeyCount === 0 && !passkeyOnly)}
			onchange={() => toggle(passkeyOnly)}
		/>
	</SettingsList>
</SectionCard>

<style>
	.notice {
		margin-bottom: 1rem;
	}
</style>
