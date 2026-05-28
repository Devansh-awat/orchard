<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import {
		pendingInvitations,
		showPendingInvitationsModal,
		showOnboarding,
		organizations,
		user,
		apiFetch,
		toasts,
		type PendingInvitation
	} from '$lib/stores';
	import { Loader2, Building2, UserPlus, X, LogOut } from 'lucide-svelte';

	let accepting = $state<string | null>(null);
	let declining = $state<string | null>(null);
	let showLogoutWarning = $state(false);

	const invitations = $derived($pendingInvitations);
	const isOpen = $derived($showPendingInvitationsModal);



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

	async function handleAccept(invitation: PendingInvitation) {
		if (accepting || declining) return;

		accepting = invitation.id;

		try {
			await pendingInvitations.accept(invitation.id, true);

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

			// Close this modal and show onboarding
			showPendingInvitationsModal.hide();
			showOnboarding.show();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to accept invitation',
				color: 'error'
			});
		} finally {
			accepting = null;
		}
	}

	async function handleDecline(invitation: PendingInvitation) {
		if (accepting || declining) return;

		declining = invitation.id;

		try {
			await pendingInvitations.decline(invitation.id, true);

			// Check if user has any organizations
			const orgsResponse = await apiFetch('/apiv1/organizations/user');
			if (orgsResponse.ok) {
				const orgs = await orgsResponse.json();
				organizations.set(orgs);

				// Get remaining invitations
				const remainingInvitations = invitations.filter(inv => inv.token !== invitation.token);

				if (orgs.length === 0 && remainingInvitations.length === 0) {
					// User has no orgs and no more pending invitations
					showLogoutWarning = true;
					declining = null;
					return;
				}
			}

			toasts.add({
				title: 'Invitation declined',
				color: 'success'
			});

			// If no more invitations, close modal
			const remaining = invitations.filter(inv => inv.token !== invitation.token);
			if (remaining.length === 0) {
				showPendingInvitationsModal.hide();
			}
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to decline invitation',
				color: 'error'
			});
		} finally {
			declining = null;
		}
	}

	function handleLogout() {
		showPendingInvitationsModal.hide();
		user.signOut();
	}

	function handleClose() {
		// Only allow closing if there are orgs or if we're showing logout warning
		if (showLogoutWarning) return;

		const orgs = $organizations;
		if (orgs.length > 0 || invitations.length === 0) {
			showPendingInvitationsModal.hide();
		}
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			handleClose();
		}
	}
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		transition:fade={{ duration: 150 }}
		onclick={handleBackdropClick}
		role="dialog"
		aria-modal="true"
	>
		<div
			class="card w-full max-w-lg overflow-hidden"
			transition:scale={{ duration: 150, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
		>
			{#if showLogoutWarning}
				<!-- Logout warning state -->
				<div class="p-6 text-center">
					<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/30">
						<LogOut class="h-6 w-6 text-yellow-600 dark:text-yellow-400" />
					</div>
					<h2 class="text-xl font-semibold" style="color: var(--center-channel-color);">
						No Organization Access
					</h2>
					<p class="mt-2" style="color: var(--surface-muted);">
						You need to be part of an organization to use Orchard. Since you declined all invitations and don't belong to any organization, you'll be logged out.
					</p>
					<button onclick={handleLogout} class="btn btn-primary mt-6 w-full">
						<LogOut class="h-4 w-4" />
						Sign Out
					</button>
				</div>
			{:else}
				<!-- Header -->
				<div class="flex items-center justify-between border-b p-4" style="border-color: var(--surface-border);">
					<div class="flex items-center gap-3">
						<div class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-100 dark:bg-primary-900/30">
							<UserPlus class="h-5 w-5 text-primary-600" />
						</div>
						<div>
							<h2 class="font-semibold" style="color: var(--center-channel-color);">
								Pending Invitations
							</h2>
							<p class="text-sm" style="color: var(--surface-muted);">
								{invitations.length} organization{invitations.length === 1 ? '' : 's'} want you to join
							</p>
						</div>
					</div>
					{#if $organizations.length > 0}
						<button
							onclick={handleClose}
							class="rounded-lg p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
							aria-label="Close"
						>
							<X class="h-5 w-5" style="color: var(--surface-muted);" />
						</button>
					{/if}
				</div>

				<!-- Invitations list -->
				<div class="max-h-96 overflow-y-auto p-4">
					<div class="space-y-3">
						{#each invitations as invitation (invitation.id)}
							<div
								class="rounded-xl border p-4"
								style="border-color: var(--surface-border); background-color: var(--control-bg);"
							>
								<div class="flex items-start gap-3">
									<div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-100 dark:bg-primary-900/30">
										{#if invitation.organization.avatarUrl}
											<img
												src={invitation.organization.avatarUrl}
												alt={invitation.organization.name}
												class="h-12 w-12 rounded-xl object-cover"
											/>
										{:else}
											<Building2 class="h-6 w-6 text-primary-600" />
										{/if}
									</div>
									<div class="min-w-0 flex-1">
										<div class="flex items-start justify-between gap-2">
											<h3 class="font-semibold" style="color: var(--center-channel-color);">
												{invitation.organization.name}
											</h3>
											<span class={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${getRoleBadgeColor(invitation.role)}`}>
												{invitation.role}
											</span>
										</div>
										<p class="mt-1 text-sm" style="color: var(--surface-muted);">
											Invited by {pendingInvitations.getInviterName(invitation.inviter)}
										</p>
										<div class="mt-3 flex gap-2">
											<button
												onclick={() => handleDecline(invitation)}
												disabled={accepting !== null || declining !== null}
												class="btn btn-secondary btn-sm flex-1"
											>
												{#if declining === invitation.token}
													<Loader2 class="h-4 w-4 animate-spin" />
												{/if}
												Decline
											</button>
											<button
												onclick={() => handleAccept(invitation)}
												disabled={accepting !== null || declining !== null}
												class="btn btn-primary btn-sm flex-1"
											>
												{#if accepting === invitation.token}
													<Loader2 class="h-4 w-4 animate-spin" />
												{/if}
												Accept
											</button>
										</div>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
