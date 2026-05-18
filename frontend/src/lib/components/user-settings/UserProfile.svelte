<script lang="ts">
	import { Loader2, Pencil, Camera, X, Eye, EyeOff, Check } from 'lucide-svelte';

	interface UserData {
		firstName?: string;
		lastName?: string;
		name?: string;
		username?: string;
		email?: string;
		imageUrl?: string;
	}

	let {
		user,
		displayEmail,
		emailRevealed = $bindable(false),
		editingField = $bindable<string | null>(null),
		editValue = $bindable(''),
		savingField,
		uploadingAvatar,
		deletingAvatar,
		onStartEditField,
		onCancelEditField,
		onSaveField,
		onFieldKeydown,
		onUploadAvatar,
		onDeleteAvatar,
		avatarInputRef = $bindable<HTMLInputElement | undefined>(undefined),
	}: {
		user: UserData | null;
		displayEmail: string;
		emailRevealed: boolean;
		editingField: string | null;
		editValue: string;
		savingField: boolean;
		uploadingAvatar: boolean;
		deletingAvatar: boolean;
		onStartEditField: (field: string) => void;
		onCancelEditField: () => void;
		onSaveField: () => void;
		onFieldKeydown: (e: KeyboardEvent) => void;
		onUploadAvatar: (event: Event) => void;
		onDeleteAvatar: () => void;
		avatarInputRef?: HTMLInputElement | undefined;
	} = $props();

	const fields = $derived([
		{ key: 'firstName', label: 'First name', value: user?.firstName || '—', mono: false },
		{ key: 'lastName', label: 'Last name', value: user?.lastName || '—', mono: false },
		{ key: 'username', label: 'Username', value: user?.username || '—', mono: true }
	]);
</script>

<!-- Profile -->
<input
	bind:this={avatarInputRef}
	type="file"
	accept="image/jpeg,image/png,image/gif,image/webp"
	class="us-hidden-input"
	onchange={onUploadAvatar}
/>
<div class="us-identity">
	<div class="us-avatar-wrapper">
		<div class="us-avatar">
			{#if user?.imageUrl}
				<img src={user.imageUrl} alt={user.name || 'User'} class="us-avatar-img" />
			{:else}
				<span class="us-avatar-letter">
					{user?.firstName?.[0] || user?.name?.[0] || 'U'}
				</span>
			{/if}
		</div>
		<div class="us-avatar-actions">
			<button
				class="us-avatar-btn"
				onclick={() => avatarInputRef?.click()}
				disabled={uploadingAvatar}
				title="Upload photo"
			>
				{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera class="h-3 w-3" />{/if}
			</button>
			{#if user?.imageUrl}
				<button
					class="us-avatar-btn us-avatar-btn--danger"
					onclick={onDeleteAvatar}
					disabled={deletingAvatar}
					title="Remove photo"
				>
					{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X class="h-3 w-3" />{/if}
				</button>
			{/if}
		</div>
	</div>
	<div class="us-identity-text">
		<h1 class="us-name">
			{#if user?.firstName || user?.lastName}
				{user?.firstName || ''} {user?.lastName || ''}
			{:else}
				{user?.name || user?.username || 'User'}
			{/if}
		</h1>
		<p class="us-email">
			{displayEmail}
			<button
				class="us-reveal"
				onclick={() => emailRevealed = !emailRevealed}
				aria-label={emailRevealed ? 'Hide email' : 'Show email'}
			>
				{#if emailRevealed}<EyeOff class="h-3 w-3" />{:else}<Eye class="h-3 w-3" />{/if}
			</button>
		</p>
	</div>
</div>

<div class="us-card-divider"></div>

<!-- Inline-editable fields in columns -->
<div class="us-fields-grid">
	{#each fields as field}
		<div class="us-field-cell" class:us-field-cell--editing={editingField === field.key}>
			<span class="us-label">{field.label}</span>
			{#if editingField === field.key}
				<div class="us-inline-edit">
					<input
						class="us-inline-input"
						class:us-inline-input--mono={field.mono}
						type="text"
						bind:value={editValue}
						onkeydown={onFieldKeydown}
						autofocus
					/>
					<div class="us-inline-btns">
						<button class="us-inline-btn us-inline-btn--save" onclick={onSaveField} disabled={savingField}>
							{#if savingField}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}
						</button>
						<button class="us-inline-btn" onclick={onCancelEditField}><X class="h-3 w-3" /></button>
					</div>
				</div>
			{:else}
				<div class="us-field-value-row">
					<span class="us-value" class:us-value--mono={field.mono}>{field.value}</span>
					<button class="us-field-edit" onclick={() => onStartEditField(field.key)}>
						<Pencil class="h-3 w-3" />
					</button>
				</div>
			{/if}
		</div>
	{/each}
</div>
