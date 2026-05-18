<script lang="ts">
	import { Loader2, Fingerprint, Pencil, Trash2, Check, X, Plus } from 'lucide-svelte';

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
		editingPasskeyId = $bindable<string | null>(null),
		renameValue = $bindable(''),
		renaming,
		deletingPasskeyId,
		onRegister,
		onStartRenaming,
		onCancelRenaming,
		onSavePasskeyName,
		onConfirmDelete,
		formatTimestamp,
	}: {
		passkeys: PasskeyRecord[];
		passkeysLoading: boolean;
		passkeyListError: string | null;
		passkeyEnvWarning: string | null;
		registerLoading: boolean;
		showAddPasskey: boolean;
		newPasskeyName: string;
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
	} = $props();
</script>

<div class="us-card-section">
	<div class="us-section-head">
		<div class="us-section-icon us-section-icon--passkey">
			<Fingerprint class="h-4 w-4" />
		</div>
		<div class="us-section-title-group">
			<h2 class="us-section-title">Passkeys</h2>
			<p class="us-section-desc">Sign in with Touch ID, Face ID, or Windows Hello</p>
		</div>
		{#if !passkeysLoading && passkeys.length > 0}
			<span class="us-count">{passkeys.length}</span>
		{/if}
	</div>

	{#if passkeyEnvWarning}
		<div class="us-warning">{passkeyEnvWarning}</div>
	{/if}

	{#if passkeyListError}
		<div class="us-error">{passkeyListError}</div>
	{/if}

	{#if passkeysLoading}
		<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else}
		{#if passkeys.length > 0}
			<div class="us-passkey-list">
				{#each passkeys as passkey}
					<div class="us-passkey">
						<div class="us-passkey-dot"></div>
						<div class="us-passkey-body">
							{#if editingPasskeyId === passkey.id}
								<div class="us-passkey-edit-row">
									<input class="us-inline-input us-inline-input--sm" type="text" placeholder="Friendly name" bind:value={renameValue} />
									<button class="us-inline-btn us-inline-btn--save" type="button" onclick={onSavePasskeyName} disabled={renaming}>
										{#if renaming}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}
									</button>
									<button class="us-inline-btn" type="button" onclick={onCancelRenaming}><X class="h-3 w-3" /></button>
								</div>
							{:else}
								<span class="us-passkey-name">{passkey.friendlyName || 'Passkey'}</span>
								<span class="us-passkey-meta">
									Last used {formatTimestamp(passkey.lastUsedAt)} · Added {formatTimestamp(passkey.createdAt)}
								</span>
							{/if}
						</div>
						{#if editingPasskeyId !== passkey.id}
							<div class="us-passkey-actions">
								<button class="us-icon-btn" type="button" onclick={() => onStartRenaming(passkey)} title="Rename">
									<Pencil class="h-3 w-3" />
								</button>
								<button class="us-icon-btn us-icon-btn--danger" type="button" onclick={() => onConfirmDelete(passkey)} disabled={deletingPasskeyId === passkey.id} title="Remove">
									{#if deletingPasskeyId === passkey.id}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Trash2 class="h-3 w-3" />{/if}
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="us-empty-hint">No passkeys yet. Add one to skip email codes when signing in.</p>
		{/if}

		{#if showAddPasskey}
			<div class="us-add-passkey-row">
				<input class="us-inline-input" type="text" placeholder="Device name (optional)" bind:value={newPasskeyName} />
				<button class="us-btn us-btn-solid" type="button" onclick={onRegister} disabled={registerLoading}>
					{#if registerLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					Register
				</button>
				<button class="us-btn us-btn-ghost" type="button" onclick={() => { showAddPasskey = false; newPasskeyName = ''; }}>Cancel</button>
			</div>
		{:else}
			<button class="us-add-btn" onclick={() => (showAddPasskey = true)}>
				<Plus class="h-3.5 w-3.5" />
				Add passkey
			</button>
		{/if}
	{/if}
</div>
