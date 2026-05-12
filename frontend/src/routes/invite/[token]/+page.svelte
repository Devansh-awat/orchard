<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		user,
		isSignedIn,
		apiFetch,
		toasts,
		organizations,
		pendingInvitations,
		showOnboarding
	} from '$lib/stores';
	import { Loader2, Building2, UserPlus, AlertCircle, LogOut } from 'lucide-svelte';

	interface InvitationDetails {
		id: string;
		token: string;
		email: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
		expiresAt: string;
		organization: {
			id: string;
			name: string;
			slug: string;
			avatarUrl?: string;
		};
		inviter: {
			firstName?: string;
			lastName?: string;
			username?: string;
			email: string;
		};
	}

	let loading = $state(true);
	let invitation = $state<InvitationDetails | null>(null);
	let error = $state<string | null>(null);
	let accepting = $state(false);
	let declining = $state(false);
	let emailMismatch = $state(false);
	let showLogoutWarning = $state(false);

	const token = $derived($page.params.token);

	function getInviterName(inviter: InvitationDetails['inviter']): string {
		if (inviter.firstName && inviter.lastName) {
			return `${inviter.firstName} ${inviter.lastName}`;
		}
		if (inviter.firstName) {
			return inviter.firstName;
		}
		if (inviter.username) {
			return inviter.username;
		}
		return inviter.email;
	}

	function getRoleBadgeColor(role: string): string {
		switch (role) {
			case 'owner':
				return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
			case 'admin':
				return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
			default:
				return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
		}
	}

	async function fetchInvitation() {
		loading = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/invitations/${token}`);

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				if (response.status === 404) {
					error = 'This invitation link is invalid or has already been used.';
				} else if (response.status === 400) {
					error = data?.message || 'This invitation has expired.';
				} else {
					error = data?.message || 'Failed to load invitation details.';
				}
				return;
			}

			invitation = await response.json();

			// Check if logged in user's email matches
			if ($isSignedIn && $user && invitation) {
				emailMismatch = $user.email?.toLowerCase() !== invitation.email.toLowerCase();
			}
		} catch (e) {
			error = 'Failed to load invitation. Please try again.';
		} finally {
			loading = false;
		}
	}

	async function handleAccept() {
		if (!invitation || accepting) return;

		accepting = true;

		try {
			await pendingInvitations.accept(invitation.token);

			// Refresh organizations
			const orgsResponse = await apiFetch('/apiv1/organizations/user');
			if (orgsResponse.ok) {
				const orgs = await orgsResponse.json();
				organizations.set(orgs);
				organizations.initializeSelected();
			}

			toasts.add({
				title: 'Welcome!',
				description: `You've joined ${invitation.organization.name}`,
				color: 'success'
			});

			// Show onboarding modal
			showOnboarding.show();

			// Navigate to home
			goto('/');
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to accept invitation',
				color: 'error'
			});
		} finally {
			accepting = false;
		}
	}

	async function handleDecline() {
		if (!invitation || declining) return;

		declining = true;

		try {
			await pendingInvitations.decline(invitation.token);

			// Check if user has any organizations
			const orgsResponse = await apiFetch('/apiv1/organizations/user');
			if (orgsResponse.ok) {
				const orgs = await orgsResponse.json();
				organizations.set(orgs);

				if (orgs.length === 0) {
					// User has no orgs, show logout warning
					showLogoutWarning = true;
					declining = false;
					return;
				}
			}

			toasts.add({
				title: 'Invitation declined',
				color: 'success'
			});

			goto('/');
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to decline invitation',
				color: 'error'
			});
		} finally {
			declining = false;
		}
	}

	function handleLogout() {
		user.signOut();
	}

	function handleSignIn() {
		// Store the current URL to redirect back after login
		if (typeof window !== 'undefined') {
			sessionStorage.setItem('inviteRedirect', window.location.pathname);
		}
		user.signIn();
	}

	onMount(() => {
		fetchInvitation();
	});
</script>

<div class="flex min-h-screen items-center justify-center p-6" style="background-color: var(--center-channel-bg);">
	<div class="w-full max-w-md">
		<div class="mb-8 text-center">
			<img src="/logo/logocompact.svg" alt="Orchard" class="mx-auto h-8 logo-light" />
			<img src="/logo/logocompactdm.svg" alt="Orchard" class="mx-auto h-8 logo-dark" />
		</div>
		{#if loading}
			<div class="text-center">
				<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
				<p class="mt-4" style="color: var(--surface-muted);">Loading invitation...</p>
			</div>
		{:else if error}
			<div class="card p-8 text-center">
				<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
					<AlertCircle class="h-6 w-6 text-red-600 dark:text-red-400" />
				</div>
				<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
					Invalid Invitation
				</h1>
				<p class="mb-6" style="color: var(--surface-muted);">{error}</p>
				<a href="/" class="btn btn-primary">Go to Home</a>
			</div>
		{:else if showLogoutWarning}
			<div class="card p-8 text-center">
				<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/30">
					<LogOut class="h-6 w-6 text-yellow-600 dark:text-yellow-400" />
				</div>
				<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
					No Organization Access
				</h1>
				<p class="mb-6" style="color: var(--surface-muted);">
					You need to be part of an organization to use Orchard. Since you declined this invitation and don't belong to any other organization, you'll be logged out.
				</p>
				<button onclick={handleLogout} class="btn btn-primary w-full">
					<LogOut class="h-4 w-4" />
					Sign Out
				</button>
			</div>
		{:else if invitation}
			<div class="card overflow-hidden">
				<!-- Header -->
				<div class="border-b p-6 text-center" style="border-color: var(--surface-border);">
					<div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-100 dark:bg-primary-900/30">
						{#if invitation.organization.avatarUrl}
							<img
								src={invitation.organization.avatarUrl}
								alt={invitation.organization.name}
								class="h-16 w-16 rounded-2xl object-cover"
							/>
						{:else}
							<Building2 class="h-8 w-8 text-primary-600" />
						{/if}
					</div>
					<h1 class="text-xl font-semibold" style="color: var(--center-channel-color);">
						You're invited to join
					</h1>
					<h2 class="mt-1 text-2xl font-bold" style="color: var(--center-channel-color);">
						{invitation.organization.name}
					</h2>
				</div>

				<!-- Details -->
				<div class="space-y-4 p-6">
					<div class="flex items-center justify-between rounded-xl p-4" style="background-color: var(--control-bg);">
						<div>
							<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Invited by</p>
							<p class="font-medium" style="color: var(--center-channel-color);">
								{getInviterName(invitation.inviter)}
							</p>
						</div>
						<div class="text-right">
							<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Role</p>
							<span class={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${getRoleBadgeColor(invitation.role)}`}>
								{invitation.role}
							</span>
						</div>
					</div>

					{#if !$isSignedIn}
						<!-- Not logged in -->
						<div class="rounded-xl border-2 border-dashed p-4 text-center" style="border-color: var(--surface-border);">
							<UserPlus class="mx-auto h-8 w-8 text-primary-600" />
							<p class="mt-2 text-sm" style="color: var(--surface-muted);">
								Sign in with <strong>{invitation.email}</strong> to accept this invitation.
							</p>
						</div>
						<button onclick={handleSignIn} class="btn btn-primary w-full">
							Sign In to Accept
						</button>
					{:else if emailMismatch}
						<!-- Email mismatch -->
						<div class="rounded-xl border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900/40 dark:bg-yellow-900/20">
							<p class="text-sm text-yellow-800 dark:text-yellow-200">
								This invitation was sent to <strong>{invitation.email}</strong>, but you're signed in as <strong>{$user?.email}</strong>.
							</p>
							<p class="mt-2 text-sm text-yellow-700 dark:text-yellow-300">
								Please sign in with the correct email to accept this invitation.
							</p>
						</div>
						<button onclick={() => user.signOut()} class="btn btn-secondary w-full">
							Sign Out and Use Different Account
						</button>
					{:else}
						<!-- Can accept -->
						<div class="flex gap-3">
							<button
								onclick={handleDecline}
								disabled={declining || accepting}
								class="btn btn-secondary flex-1"
							>
								{#if declining}
									<Loader2 class="h-4 w-4 animate-spin" />
								{/if}
								Decline
							</button>
							<button
								onclick={handleAccept}
								disabled={accepting || declining}
								class="btn btn-primary flex-1"
							>
								{#if accepting}
									<Loader2 class="h-4 w-4 animate-spin" />
								{/if}
								Accept Invitation
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
