<script lang="ts">
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
	import { Building2, UserPlus, LogOut } from 'lucide-svelte';
	import { Modal, Button, Badge } from '$lib/components/ui';

	let accepting = $state<string | null>(null);
	let declining = $state<string | null>(null);
	let showLogoutWarning = $state(false);

	const invitations = $derived($pendingInvitations);
	const isOpen = $derived($showPendingInvitationsModal);
	const closable = $derived(
		!showLogoutWarning && ($organizations.length > 0 || invitations.length === 0)
	);

	function getRoleTone(role: string): 'warning' | 'info' | 'neutral' {
		switch (role) {
			case 'owner':
				return 'warning';
			case 'admin':
				return 'info';
			default:
				return 'neutral';
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
				title: 'Invitation accepted',
				description: `You joined ${invitation.organization.name}`,
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
				const remainingInvitations = invitations.filter((inv) => inv.token !== invitation.token);

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
			const remaining = invitations.filter((inv) => inv.token !== invitation.token);
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
		if (!closable) return;
		showPendingInvitationsModal.hide();
	}
</script>

<Modal open={isOpen} {closable} size="lg" onclose={handleClose}>
	{#if showLogoutWarning}
		<div class="p-2 text-center">
			<div
				class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full"
				style="background-color: var(--warning-bg);"
			>
				<LogOut class="h-6 w-6" style="color: var(--warning-text);" />
			</div>
			<h2 class="text-xl font-semibold" style="color: var(--center-channel-color);">
				No organization access
			</h2>
			<p class="mt-2" style="color: var(--surface-muted);">
				You need to be part of an organization to use Orchard. Since you declined all invitations
				and don't belong to any organization, you'll be logged out.
			</p>
			<Button variant="primary" class="mt-6 w-full" onclick={handleLogout}>
				<LogOut class="h-4 w-4" />
				Sign out
			</Button>
		</div>
	{:else}
		<div
			class="mb-4 flex items-center gap-3 border-b pb-4"
			style="border-color: var(--surface-border);"
		>
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-100 dark:bg-primary-900/30"
			>
				<UserPlus class="h-5 w-5 text-primary-600" />
			</div>
			<div>
				<h2 class="font-semibold" style="color: var(--center-channel-color);">
					Pending invitations
				</h2>
				<p class="text-sm" style="color: var(--surface-muted);">
					{invitations.length} organization{invitations.length === 1 ? '' : 's'} want you to join
				</p>
			</div>
		</div>

		<div class="max-h-96 space-y-3 overflow-y-auto">
			{#each invitations as invitation (invitation.id)}
				<div
					class="rounded-xl border p-4"
					style="border-color: var(--surface-border); background-color: var(--control-bg);"
				>
					<div class="flex items-start gap-3">
						<div
							class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-100 dark:bg-primary-900/30"
						>
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
								<span class="shrink-0 capitalize">
									<Badge tone={getRoleTone(invitation.role)}>{invitation.role}</Badge>
								</span>
							</div>
							<p class="mt-1 text-sm" style="color: var(--surface-muted);">
								Invited by {pendingInvitations.getInviterName(invitation.inviter)}
							</p>
							<div class="mt-3 flex gap-2">
								<Button
									variant="secondary"
									size="sm"
									class="flex-1"
									onclick={() => handleDecline(invitation)}
									loading={declining === invitation.id}
									disabled={accepting !== null || declining !== null}
								>
									Decline
								</Button>
								<Button
									variant="primary"
									size="sm"
									class="flex-1"
									onclick={() => handleAccept(invitation)}
									loading={accepting === invitation.id}
									disabled={accepting !== null || declining !== null}
								>
									Accept
								</Button>
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</Modal>
