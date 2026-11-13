<script lang="ts">
	import { tick } from 'svelte';
	import { Fingerprint, Pencil, Plus, Trash2 } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Field,
		Input,
		List,
		ListRow,
		Modal,
		ModalIntro,
		SecretInput,
		SectionCard,
		Skeleton,
		ToneTile
	} from '$lib/components/ui';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';

	interface PasskeyRecord {
		id: string;
		friendlyName?: string | null;
		createdAt: string;
		lastUsedAt?: string | null;
		deviceType?: string | null;
		backedUp?: boolean;
		transports?: string[];
	}

	let {
		passkeys,
		passkeysLoading,
		passkeyListError,
		passkeyEnvWarning,
		registerLoading,
		showAddPasskey = $bindable(false),
		newPasskeyName = $bindable(''),
		currentPassword = $bindable(''),
		needsCurrent = false,
		stale = false,
		onSignInAgain,
		editingPasskeyId = $bindable<string | null>(null),
		renameValue = $bindable(''),
		renaming,
		deletingPasskeyId,
		onRegister,
		onStartRenaming,
		onCancelRenaming,
		onSavePasskeyName,
		onConfirmDelete
	}: {
		passkeys: PasskeyRecord[];
		passkeysLoading: boolean;
		passkeyListError: string | null;
		passkeyEnvWarning: string | null;
		registerLoading: boolean;
		showAddPasskey: boolean;
		newPasskeyName: string;
		currentPassword?: string;
		needsCurrent?: boolean;
		stale?: boolean;
		onSignInAgain?: () => void;
		editingPasskeyId: string | null;
		renameValue: string;
		renaming: boolean;
		deletingPasskeyId: string | null;
		onRegister: () => void;
		onStartRenaming: (passkey: PasskeyRecord) => void;
		onCancelRenaming: () => void;
		onSavePasskeyName: () => void;
		onConfirmDelete: (passkey: PasskeyRecord) => void;
		formatTimestamp: (value?: string | null) => string;
		index?: number;
	} = $props();

	const uid = $props.id();

	const editing = $derived(passkeys.find((p) => p.id === editingPasskeyId) ?? null);

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => el.focus());
	}

	function cancelAdd() {
		showAddPasskey = false;
		newPasskeyName = '';
		currentPassword = '';
	}
</script>

<SectionCard title="Passkeys" description="Sign in with Touch ID, Face ID or Windows Hello.">
	{#snippet actions()}
		<Button size="sm" icon={Plus} onclick={() => (showAddPasskey = true)}>Add passkey</Button>
	{/snippet}
	<div class="body">
		{#if passkeyEnvWarning}
			<Alert tone="warning">{passkeyEnvWarning}</Alert>
		{/if}
		{#if passkeyListError}
			<Alert tone="error">{passkeyListError}</Alert>
		{/if}
		{#if passkeysLoading}
			<div class="placeholder">
				<Skeleton height="2.5rem" />
				<Skeleton height="2.5rem" />
			</div>
		{:else if passkeys.length === 0}
			{#if !passkeyListError}
				<p class="quiet">No passkeys yet. Add one to skip email codes when you sign in.</p>
			{/if}
		{:else}
			<List inset={false} label="Passkeys">
				{#each passkeys as passkey (passkey.id)}
					<ListRow flush presence title={passkey.friendlyName || 'Passkey'}>
						{#snippet leading()}<ToneTile size={32}><Fingerprint size={16} /></ToneTile>{/snippet}
						{#snippet subtitle()}
							<span>
								{#if passkey.lastUsedAt}Used <RelativeTime date={passkey.lastUsedAt} />{:else}Never
									used{/if}
								· Added <RelativeTime date={passkey.createdAt} />
							</span>
						{/snippet}
						{#snippet actions()}
							<Button
								size="sm"
								variant="ghost"
								icon={Pencil}
								label={`Rename ${passkey.friendlyName || 'passkey'}`}
								onclick={() => onStartRenaming(passkey)}
							/>
							<Button
								size="sm"
								variant="ghost"
								icon={Trash2}
								label={`Remove ${passkey.friendlyName || 'passkey'}`}
								loading={deletingPasskeyId === passkey.id}
								onclick={() => onConfirmDelete(passkey)}
							/>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</div>
</SectionCard>

<Modal
	bind:open={showAddPasskey}
	size="sm"
	closable={false}
	dismissable={!registerLoading}
	onclose={() => (newPasskeyName = '')}
	labelledby="{uid}-title"
>
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			onRegister();
		}}
	>
		<ModalIntro
			id="{uid}-title"
			icon={Fingerprint}
			tone="accent"
			title="Add a passkey"
			description="Your browser asks for Touch ID, Face ID or a security key."
		/>
		<Field label="Name" for="{uid}-name" hint="Optional">
			<Input
				id="{uid}-name"
				bind:value={newPasskeyName}
				placeholder="MacBook"
				autocomplete="off"
				{@attach focusOnOpen}
			/>
		</Field>
		{#if needsCurrent}
			<Field label="Current password" for="{uid}-current">
				<SecretInput
					id="{uid}-current"
					bind:value={currentPassword}
					autocomplete="current-password"
				/>
			</Field>
		{/if}
	</form>
	{#snippet footer()}
		<Button variant="ghost" shape="capsule" disabled={registerLoading} onclick={cancelAdd}
			>Cancel</Button
		>
		{#if stale && onSignInAgain}
			<Button variant="primary" shape="capsule" onclick={onSignInAgain}>Sign in again</Button>
		{:else}
			<Button variant="primary" shape="capsule" loading={registerLoading} onclick={onRegister}
				>Continue</Button
			>
		{/if}
	{/snippet}
</Modal>

<RenameModal
	bind:open={() => editingPasskeyId !== null, (open) => !open && onCancelRenaming()}
	title="Rename passkey"
	value={editing?.friendlyName || ''}
	placeholder="MacBook"
	saving={renaming}
	onSave={(name) => {
		renameValue = name;
		onSavePasskeyName();
	}}
/>

<style>
	.body,
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.quiet {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
