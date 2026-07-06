<script lang="ts">
	import { Loader2, Camera, X } from 'lucide-svelte';
	import { UserPen, Eye, EyeOff } from '@jis3r/icons';
	import SettingsSection from './SettingsSection.svelte';
	import SettingsField from './SettingsField.svelte';

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
		index = 0
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
		index?: number;
	} = $props();

	let revealHovered = $state(false);

	const fields = $derived([
		{ key: 'firstName', label: 'First name', value: user?.firstName || 'Not set', mono: false },
		{ key: 'lastName', label: 'Last name', value: user?.lastName || 'Not set', mono: false },
		{ key: 'username', label: 'Username', value: user?.username || 'Not set', mono: true }
	]);
</script>

<input
	bind:this={avatarInputRef}
	type="file"
	accept="image/jpeg,image/png,image/gif,image/webp"
	class="sr-only"
	onchange={onUploadAvatar}
/>

<SettingsSection
	title="Profile"
	description="Your personal information"
	iconColor="primary"
	{index}
>
	{#snippet icon(hovered)}<UserPen size={18} animate={hovered} />{/snippet}

	<div class="up-identity">
		<div class="up-avatar-wrapper">
			<div class="up-avatar">
				{#if user?.imageUrl}
					<img src={user.imageUrl} alt={user.name || 'User'} class="up-avatar-img" />
				{:else}
					<span class="up-avatar-letter">
						{user?.firstName?.[0] || user?.name?.[0] || 'U'}
					</span>
				{/if}
			</div>
			<div class="up-avatar-actions">
				<button
					class="up-avatar-btn"
					onclick={() => avatarInputRef?.click()}
					disabled={uploadingAvatar}
					title="Upload photo"
				>
					{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera
							class="h-3 w-3"
						/>{/if}
				</button>
				{#if user?.imageUrl}
					<button
						class="up-avatar-btn up-avatar-btn--danger"
						onclick={onDeleteAvatar}
						disabled={deletingAvatar}
						title="Remove photo"
					>
						{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X
								class="h-3 w-3"
							/>{/if}
					</button>
				{/if}
			</div>
		</div>
		<div class="up-identity-text">
			<h1 class="up-name">
				{#if user?.firstName || user?.lastName}
					{user?.firstName || ''} {user?.lastName || ''}
				{:else}
					{user?.name || user?.username || 'User'}
				{/if}
			</h1>
			<p class="up-email">
				{displayEmail}
				<button
					class="up-reveal"
					onclick={() => (emailRevealed = !emailRevealed)}
					aria-label={emailRevealed ? 'Hide email' : 'Show email'}
					onmouseenter={() => (revealHovered = true)}
					onmouseleave={() => (revealHovered = false)}
				>
					{#if emailRevealed}<EyeOff size={13} animate={revealHovered} />{:else}<Eye
							size={13}
							animate={revealHovered}
						/>{/if}
				</button>
			</p>
		</div>
	</div>

	<div class="up-fields">
		{#each fields as field (field.key)}
			<SettingsField
				label={field.label}
				value={field.value}
				mono={field.mono}
				editing={editingField === field.key}
				editValue={editingField === field.key ? editValue : ''}
				saving={savingField}
				onSave={onSaveField}
				onCancel={onCancelEditField}
				onStartEdit={() => onStartEditField(field.key)}
				onKeydown={onFieldKeydown}
			/>
		{/each}
	</div>
</SettingsSection>

<style>
	.sr-only {
		position: absolute;
		width: 0;
		height: 0;
		opacity: 0;
		pointer-events: none;
	}
	.up-identity {
		display: flex;
		align-items: center;
		gap: 1.125rem;
		margin-bottom: 0.25rem;
	}
	.up-avatar-wrapper {
		position: relative;
		flex-shrink: 0;
	}
	.up-avatar-wrapper:hover .up-avatar-actions {
		opacity: 1;
	}
	.up-avatar {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 0.875rem;
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--button-bg) 18%, transparent),
			color-mix(in srgb, var(--button-bg) 6%, transparent)
		);
		color: var(--button-bg);
	}
	.up-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.up-avatar-letter {
		font-size: 1.25rem;
		font-weight: 700;
	}
	.up-avatar-actions {
		position: absolute;
		bottom: -0.25rem;
		right: -0.25rem;
		display: flex;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity 150ms;
	}
	.up-avatar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 50%;
		border: 1.5px solid var(--surface-bg);
		background-color: var(--button-bg);
		color: var(--button-color);
		cursor: pointer;
		transition: all 120ms;
		padding: 0;
	}
	.up-avatar-btn:hover:not(:disabled) {
		opacity: 0.85;
	}
	.up-avatar-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.up-avatar-btn--danger {
		background-color: var(--error-text-color);
	}
	.up-identity-text {
		flex: 1;
		min-width: 0;
	}
	.up-name {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		letter-spacing: -0.02em;
		line-height: 1.2;
		margin: 0;
	}
	.up-email {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0.125rem;
	}
	.up-reveal {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem;
		border-radius: 0.25rem;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: color 120ms;
	}
	.up-reveal:hover {
		color: var(--center-channel-color);
	}
	.up-fields {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		margin: 0 -1.5rem;
		border-top: 1px solid var(--surface-border);
		margin-top: 1rem;
	}
	.up-fields > :global(:not(:first-child)) {
		border-left: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
	}
	@media (max-width: 640px) {
		.up-fields {
			grid-template-columns: 1fr;
			margin: 0 -1.25rem;
		}
		.up-fields > :global(:not(:first-child)) {
			border-left: none;
			border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
		}
	}
</style>
