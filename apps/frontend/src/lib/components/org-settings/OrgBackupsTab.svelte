<script lang="ts">
	import { Archive, KeyRound, Pencil } from 'lucide-svelte';
	import {
		Button,
		FormActions,
		Input,
		List,
		ListRow,
		SecretInput,
		SectionCard,
		SettingRow,
		SettingsList,
		Skeleton,
		Swap,
		ToneTile
	} from '$lib/components/ui';

	let {
		canEditOrg,
		isOwner,
		backupLoading,
		backupSaving,
		backupConfigured,
		backupEditMode = $bindable(false),
		backupEndpoint = $bindable(''),
		backupBucket = $bindable(''),
		backupRegion = $bindable('auto'),
		backupAccessKey = $bindable(''),
		backupSecretKey = $bindable(''),
		backupAccessKeyConfigured,
		backupAccessKeyLast4,
		backupSecretConfigured,
		onSaveBackupSettings,
		onClearBackupSettings,
		onCancelEdit
	}: {
		canEditOrg: boolean;
		isOwner: boolean;
		backupLoading: boolean;
		backupSaving: boolean;
		backupConfigured: boolean;
		backupEditMode: boolean;
		backupEndpoint: string;
		backupBucket: string;
		backupRegion: string;
		backupAccessKey: string;
		backupSecretKey: string;
		backupAccessKeyConfigured: boolean;
		backupAccessKeyLast4: string | null;
		backupSecretConfigured: boolean;
		onSaveBackupSettings: () => void;
		onClearBackupSettings: () => void;
		onCancelEdit: () => void;
		index?: number;
	} = $props();

	const reading = $derived(backupConfigured && !backupEditMode);
	const mode = $derived(
		!canEditOrg ? 'locked' : backupLoading ? 'loading' : reading ? 'read' : 'edit'
	);
	const accessKeyShown = $derived(
		backupAccessKeyConfigured ? (backupAccessKeyLast4 ? `••••${backupAccessKeyLast4}` : 'set') : ''
	);
	const endpointHost = $derived(backupEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, ''));
</script>

<SectionCard
	title="Database backups"
	description={canEditOrg && reading && !isOwner
		? 'Only the organization owner can change these.'
		: undefined}
>
	{#snippet actions()}
		{#if canEditOrg && !backupLoading && reading && isOwner}
			<Button size="sm" icon={Pencil} onclick={() => (backupEditMode = true)}>Edit</Button>
		{/if}
	{/snippet}

	<Swap key={mode}>
		{#if !canEditOrg}
			<p class="quiet">Only admins and owners can manage backups.</p>
		{:else if backupLoading}
			<div class="placeholder">
				<Skeleton height="2.5rem" />
				<Skeleton height="2.5rem" />
				<Skeleton height="2.5rem" />
			</div>
		{:else if !backupConfigured && !isOwner}
			<p class="quiet">Backups are not set up yet. Only the organization owner can set them up.</p>
		{:else if reading}
			<List inset={false} label="Backup storage">
				<ListRow
					flush
					title={backupBucket}
					subtitle="{endpointHost} · region {backupRegion || 'auto'}"
				>
					{#snippet leading()}<ToneTile size={32}><Archive size={16} /></ToneTile>{/snippet}
				</ListRow>
				<ListRow
					flush
					title={accessKeyShown ? `Access key ${accessKeyShown}` : 'No access key ID'}
					subtitle="Secret access key set"
				>
					{#snippet leading()}<ToneTile size={32}><KeyRound size={16} /></ToneTile>{/snippet}
				</ListRow>
			</List>
		{:else}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					onSaveBackupSettings();
				}}
			>
				<SettingsList label="Backup storage">
					<SettingRow label="R2 endpoint" for="ob-endpoint" wide>
						<Input
							id="ob-endpoint"
							mono
							placeholder="https://<account-id>.r2.cloudflarestorage.com"
							bind:value={backupEndpoint}
							autocomplete="off"
							spellcheck="false"
						/>
					</SettingRow>
					<SettingRow label="Bucket" for="ob-bucket" wide>
						<Input
							id="ob-bucket"
							mono
							placeholder="orchard-backups"
							bind:value={backupBucket}
							autocomplete="off"
							spellcheck="false"
						/>
					</SettingRow>
					<SettingRow label="Region" for="ob-region" wide>
						<Input
							id="ob-region"
							mono
							placeholder="auto"
							bind:value={backupRegion}
							autocomplete="off"
							spellcheck="false"
						/>
					</SettingRow>
					<SettingRow
						label="Access key ID"
						for="ob-access-key"
						hint={backupAccessKeyConfigured
							? `${backupAccessKeyLast4 ? `Ends in ${backupAccessKeyLast4}. ` : ''}Leave it empty to keep it.`
							: undefined}
						wide
					>
						<Input
							id="ob-access-key"
							mono
							placeholder={backupAccessKeyConfigured ? '••••••••••••' : 'R2 access key ID'}
							bind:value={backupAccessKey}
							autocomplete="off"
							spellcheck="false"
						/>
					</SettingRow>
					<SettingRow
						label="Secret access key"
						for="ob-secret-key"
						hint={backupSecretConfigured ? 'Leave it empty to keep it.' : undefined}
						wide
					>
						<SecretInput
							id="ob-secret-key"
							placeholder={backupSecretConfigured ? '••••••••••••' : 'R2 secret access key'}
							bind:value={backupSecretKey}
							autocomplete="off"
						/>
					</SettingRow>
				</SettingsList>
				<div class="save">
					<FormActions>
						{#if backupSecretConfigured && isOwner}
							<Button variant="ghost" onclick={onClearBackupSettings} disabled={backupSaving}>
								Clear
							</Button>
						{/if}
						{#if backupEditMode && backupConfigured}
							<Button variant="ghost" onclick={onCancelEdit} disabled={backupSaving}>Cancel</Button>
						{/if}
						<Button type="submit" variant="primary" loading={backupSaving}>Save</Button>
					</FormActions>
				</div>
			</form>
		{/if}
	</Swap>
</SectionCard>

<style>
	.quiet {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.save {
		margin-top: var(--space-4);
	}
</style>
