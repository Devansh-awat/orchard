<script lang="ts">
	import { Crown, Loader2, Check } from 'lucide-svelte';
	import { Avatar, Modal, Button, Alert } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import type { ProjectMember } from './types';

	let {
		open = $bindable(false),
		projectName,
		projectMembers,
		ownerId = null,
		submitting = false,
		onrequest
	}: {
		open?: boolean;
		projectName: string;
		projectMembers: ProjectMember[];
		ownerId?: string | null;
		submitting?: boolean;
		onrequest: (userId: string) => void;
	} = $props();

	let selectedUserId = $state<string | null>(null);

	const candidates = $derived(projectMembers.filter((m) => m.user.id !== ownerId));

	$effect(() => {
		if (!open) selectedUserId = null;
	});

	function displayName(m: ProjectMember) {
		const name = [m.user.firstName, m.user.lastName].filter(Boolean).join(' ');
		return name || m.user.email;
	}
</script>

<Modal bind:open size="sm" title="Transfer ownership">
	<p class="tf-lead">
		Ask another member to take ownership of <strong>{projectName}</strong>. Nothing moves until they
		accept.
	</p>

	<Alert tone="warning">
		The owner's resource allowance pays for everything in this project. Whoever accepts takes on
		that bill and becomes a project admin.
	</Alert>

	{#if candidates.length > 0}
		<ul class="tf-list">
			{#each candidates as m, i (m.id)}
				<li {@attach motionStagger({ index: i, axis: 'x', from: { y: -8 } })}>
					<button
						type="button"
						class="tf-option"
						class:is-selected={selectedUserId === m.user.id}
						aria-pressed={selectedUserId === m.user.id}
						onclick={() => (selectedUserId = m.user.id)}
					>
						<Avatar user={m.user} alive class="tf-avatar" />
						<span class="tf-option-text">
							<span class="tf-option-name">{displayName(m)}</span>
							<span class="tf-option-email">{m.user.email}</span>
						</span>
						<span class="tf-option-check">
							{#if selectedUserId === m.user.id}<Check size={14} />{/if}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="tf-empty">
			There is nobody to hand this to yet. Add the new owner to the project first, then transfer.
		</p>
	{/if}

	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button
			variant="primary"
			disabled={!selectedUserId || submitting}
			onclick={() => {
				if (selectedUserId) onrequest(selectedUserId);
			}}
		>
			{#if submitting}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Crown class="h-4 w-4" />
			{/if}
			Send request
		</Button>
	{/snippet}
</Modal>

<style>
	.tf-lead {
		margin: 0 0 var(--space-4);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.tf-list {
		list-style: none;
		margin: var(--space-4) 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		max-height: 15rem;
		overflow-y: auto;
	}
	.tf-option {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition:
			background-color var(--dur-fast),
			border-color var(--dur-fast);
	}
	.tf-option:hover {
		background: var(--bg-raised);
	}
	.tf-option.is-selected {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border-color: color-mix(in srgb, var(--accent) 32%, transparent);
	}
	/* Passed into `<Avatar>`: no scope hash reaches it. */
	:global(.tf-avatar) {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.tf-option-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.tf-option-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tf-option-email {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tf-option-check {
		flex-shrink: 0;
		color: var(--accent);
	}
	.tf-empty {
		margin: var(--space-4) 0 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}
</style>
