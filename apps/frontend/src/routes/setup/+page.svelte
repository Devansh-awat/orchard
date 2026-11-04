<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Loader2 } from 'lucide-svelte';
	import { user, isSignedIn, isSuperAdmin, apiFetch } from '$lib/stores';
	import { InvitationWelcome } from '$lib/components';
	import { InstanceSetup } from '$lib/components/setup';

	type Mode = 'checking' | 'instance' | 'invitation';

	let mode = $state<Mode>('checking');

	async function confirmSuperAdmin(): Promise<boolean> {
		if ($isSuperAdmin) return true;
		try {
			const response = await apiFetch('/apiv1/auth/me');
			if (!response.ok) return false;
			const me = await response.json();
			if (me?.isSuperAdmin !== true) return false;
			user.set(me);
			return true;
		} catch {
			return false;
		}
	}

	onMount(async () => {
		if (!$isSignedIn) {
			goto('/', { replaceState: true });
			return;
		}

		if ($user?.setupCompleted) {
			goto('/', { replaceState: true });
			return;
		}

		if (!(await confirmSuperAdmin())) {
			mode = 'invitation';
			return;
		}

		try {
			const response = await apiFetch('/apiv1/setup/state');
			if (!response.ok) {
				mode = 'instance';
				return;
			}
			const state = await response.json();
			const resuming =
				$page.url.searchParams.has('created') ||
				sessionStorage.getItem('orchard:instance-setup') !== null;
			mode = state.complete && !resuming ? 'invitation' : 'instance';
		} catch {
			mode = 'instance';
		}
	});
</script>

{#if mode === 'checking'}
	<div class="setup-boot" data-motion="progress">
		<Loader2 size={20} class="animate-spin" />
	</div>
{:else if mode === 'instance'}
	<InstanceSetup />
{:else if $isSignedIn && $user?.setupCompleted === false}
	<InvitationWelcome />
{/if}

<style>
	.setup-boot {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		color: var(--text-muted);
	}
</style>
