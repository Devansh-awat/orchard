<script lang="ts">
	import { Crown, FolderInput, Trash2 } from 'lucide-svelte';
	import { ActionRow, Button, SectionCard, Stack } from '$lib/components/ui';
	import RegistryCredentials from './RegistryCredentials.svelte';

	let {
		projectId,
		canEdit = false,
		canDelete = false,
		canTransferOwnership = false,
		canMoveToOrg = false,
		transferPending = false,
		deleting = false,
		onDelete,
		onTransferOwnership,
		onMoveToOrg
	}: {
		projectId: string;
		canEdit?: boolean;
		canDelete?: boolean;
		canTransferOwnership?: boolean;
		canMoveToOrg?: boolean;
		transferPending?: boolean;
		deleting?: boolean;
		onDelete?: () => void;
		onTransferOwnership?: () => void;
		onMoveToOrg?: () => void;
	} = $props();
</script>

<Stack>
	<RegistryCredentials {projectId} {canEdit} />

	{#if canTransferOwnership || canMoveToOrg || canDelete}
		<SectionCard title="Danger zone">
			<Stack>
				{#if canTransferOwnership}
					<ActionRow
						label="Transfer ownership"
						hint={transferPending
							? 'A transfer is waiting on the new owner to accept.'
							: "Everything here counts against the new owner's allowance."}
					>
						<Button size="sm" icon={Crown} disabled={transferPending} onclick={onTransferOwnership}>
							Transfer
						</Button>
					</ActionRow>
				{/if}

				{#if canMoveToOrg}
					<ActionRow
						label="Move to another organization"
						hint="Members who are not in the other organization lose access."
					>
						<Button size="sm" icon={FolderInput} onclick={onMoveToOrg}>Move</Button>
					</ActionRow>
				{/if}

				{#if canDelete}
					<ActionRow
						label="Delete project"
						hint="Deletes every environment, app, database, backup, domain and job in it. There is no undo."
					>
						<Button variant="danger" size="sm" icon={Trash2} loading={deleting} onclick={onDelete}>
							Delete
						</Button>
					</ActionRow>
				{/if}
			</Stack>
		</SectionCard>
	{/if}
</Stack>
