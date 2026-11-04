<script lang="ts">
	import { Crown } from 'lucide-svelte';
	import {
		Alert,
		Avatar,
		Button,
		Dropdown,
		Field,
		Modal,
		Stack,
		type DropdownOption
	} from '$lib/components/ui';
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

	const uid = $props.id();

	let selectedUserId = $state('');

	const candidates = $derived(projectMembers.filter((m) => m.user.id !== ownerId));
	const byUserId = $derived(new Map(candidates.map((m) => [m.user.id, m])));
	const options = $derived<DropdownOption[]>(
		candidates.map((m) => {
			const name = [m.user.firstName, m.user.lastName].filter(Boolean).join(' ');
			return {
				value: m.user.id,
				label: name || m.user.email,
				description: name ? m.user.email : undefined
			};
		})
	);

	$effect(() => {
		if (!open) selectedUserId = '';
	});
</script>

<Modal bind:open size="sm" title="Transfer ownership">
	<Stack gap="md">
		<p class="text-callout text-muted">
			Ask another member to take ownership of {projectName}. Nothing moves until they accept.
		</p>

		<Alert tone="warning">
			Everything in this project counts against the owner's resource allowance. The new owner takes
			this on and becomes a project admin.
		</Alert>

		{#if candidates.length > 0}
			<Field label="New owner" for={uid}>
				<Dropdown
					id={uid}
					bind:value={selectedUserId}
					{options}
					size="lg"
					placeholder="Choose a member"
				>
					{#snippet icon(value)}
						<Avatar user={byUserId.get(value)?.user} seed={value} size={20} />
					{/snippet}
				</Dropdown>
			</Field>
		{:else}
			<p class="text-callout text-muted">Add the new owner to this project first.</p>
		{/if}
	</Stack>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		<Button
			variant="primary"
			icon={Crown}
			loading={submitting}
			disabled={!selectedUserId}
			onclick={() => {
				if (selectedUserId) onrequest(selectedUserId);
			}}
		>
			Send request
		</Button>
	{/snippet}
</Modal>
