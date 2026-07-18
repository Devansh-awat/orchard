<script lang="ts">
	import { Loader2, Camera, X, Fingerprint, MonitorSmartphone, Github } from 'lucide-svelte';
	import { Eye, EyeOff } from '@jis3r/icons';
	import { motionStagger } from '$lib/utils/motion.svelte';
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
		passkeyCount = null,
		sessionCount = null,
		githubLinked = false,
		onJump = undefined,
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
		passkeyCount?: number | null;
		sessionCount?: number | null;
		githubLinked?: boolean;
		onJump?: (id: string) => void;
		index?: number;
	} = $props();

	let revealHovered = $state(false);

	const fields = $derived([
		{ key: 'firstName', label: 'First name', value: user?.firstName || 'Not set', mono: false },
		{ key: 'lastName', label: 'Last name', value: user?.lastName || 'Not set', mono: false },
		{ key: 'username', label: 'Username', value: user?.username || 'Not set', mono: true }
	]);

	const chips = $derived(
		[
			passkeyCount !== null && {
				id: 'passkeys',
				icon: Fingerprint,
				label: `${passkeyCount} passkey${passkeyCount === 1 ? '' : 's'}`
			},
			sessionCount !== null && {
				id: 'sessions',
				icon: MonitorSmartphone,
				label: `${sessionCount} device${sessionCount === 1 ? '' : 's'}`
			},
			{
				id: 'github',
				icon: Github,
				label: githubLinked ? 'GitHub connected' : 'GitHub not connected'
			}
		].filter(Boolean) as { id: string; icon: typeof Github; label: string }[]
	);
</script>

<input
	bind:this={avatarInputRef}
	type="file"
	accept="image/jpeg,image/png,image/gif,image/webp"
	class="uh-sr-only"
	aria-label="Upload profile photo"
	onchange={onUploadAvatar}
/>

<section
	class="uh-root"
	{@attach motionStagger({ index, stride: 0.06, from: { y: 12, opacity: 0, scale: 0.985 } })}
>
	<div class="uh-top">
		<div class="uh-avatar-wrap">
			<div class="uh-avatar">
				{#if user?.imageUrl}
					<img src={user.imageUrl} alt={user.name || 'You'} class="uh-avatar-img" />
				{:else}
					<span class="uh-avatar-letter">{user?.firstName?.[0] || user?.name?.[0] || 'U'}</span>
				{/if}
			</div>
			<div class="uh-avatar-actions">
				<button
					type="button"
					class="uh-avatar-btn"
					onclick={() => avatarInputRef?.click()}
					disabled={uploadingAvatar}
					title="Upload photo"
					aria-label="Upload photo"
				>
					{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera
							class="h-3 w-3"
						/>{/if}
				</button>
				{#if user?.imageUrl}
					<button
						type="button"
						class="uh-avatar-btn uh-avatar-btn--danger"
						onclick={onDeleteAvatar}
						disabled={deletingAvatar}
						title="Remove photo"
						aria-label="Remove photo"
					>
						{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X
								class="h-3 w-3"
							/>{/if}
					</button>
				{/if}
			</div>
		</div>
		<div class="uh-id">
			<h1 class="uh-name">
				{#if user?.firstName || user?.lastName}
					{user?.firstName || ''} {user?.lastName || ''}
				{:else}
					{user?.name || user?.username || 'You'}
				{/if}
			</h1>
			<p class="uh-sub">
				{#if user?.username}<span class="uh-username">@{user.username}</span><span class="uh-dot"
						>·</span
					>{/if}
				{displayEmail}
				<button
					type="button"
					class="uh-reveal"
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
			{#if chips.length}
				<div class="uh-chips">
					{#each chips as chip (chip.id)}
						{@const Icon = chip.icon}
						{#if onJump && chip.id !== 'github'}
							<button type="button" class="uh-chip uh-chip--link" onclick={() => onJump(chip.id)}>
								<Icon size={12} />
								{chip.label}
							</button>
						{:else}
							<span class="uh-chip">
								<Icon size={12} />
								{chip.label}
							</span>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div class="uh-fields">
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
</section>

<style>
	.uh-sr-only {
		position: absolute;
		width: 0;
		height: 0;
		opacity: 0;
		pointer-events: none;
	}
	.uh-root {
		border: 1px solid var(--border-default);
		border-radius: 1rem;
		background-color: var(--bg-surface);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		overflow: hidden;
	}
	.uh-top {
		display: flex;
		align-items: center;
		gap: 1.375rem;
		padding: 1.75rem 1.75rem 1.5rem;
	}
	.uh-avatar-wrap {
		position: relative;
		flex-shrink: 0;
	}
	.uh-avatar-wrap:hover .uh-avatar-actions {
		opacity: 1;
	}
	.uh-avatar {
		width: 4.5rem;
		height: 4.5rem;
		border-radius: 1.125rem;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 18%, transparent),
			color-mix(in srgb, var(--accent) 6%, transparent)
		);
		color: var(--accent);
		outline: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
		outline-offset: 3px;
	}
	.uh-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.uh-avatar-letter {
		font-size: 1.625rem;
		font-weight: 700;
	}
	.uh-avatar-actions {
		position: absolute;
		bottom: -0.25rem;
		right: -0.25rem;
		display: flex;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity 150ms;
	}
	.uh-avatar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		border: 1.5px solid var(--bg-surface);
		background-color: var(--accent);
		color: var(--text-on-accent);
		cursor: pointer;
		transition: opacity 120ms;
		padding: 0;
	}
	.uh-avatar-btn:hover:not(:disabled) {
		opacity: 0.85;
	}
	.uh-avatar-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.uh-avatar-btn--danger {
		background-color: var(--status-error);
	}
	.uh-id {
		flex: 1;
		min-width: 0;
	}
	.uh-name {
		font-size: 1.625rem;
		font-weight: 700;
		letter-spacing: -0.025em;
		line-height: 1.15;
		color: var(--text-default);
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.uh-sub {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--text-muted);
		margin: 0.25rem 0 0;
		min-width: 0;
	}
	.uh-username {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
	}
	.uh-dot {
		color: var(--text-faint);
	}
	.uh-reveal {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem;
		border-radius: 0.25rem;
		color: var(--text-muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: color 120ms;
	}
	.uh-reveal:hover {
		color: var(--text-default);
	}
	.uh-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.75rem;
	}
	.uh-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--text-muted);
		background-color: var(--bg-sunken);
		border: 1px solid color-mix(in srgb, var(--border-default) 70%, transparent);
		border-radius: 9999px;
		padding: 0.2rem 0.55rem;
	}
	.uh-chip--link {
		cursor: pointer;
		transition:
			color 120ms,
			background-color 120ms;
	}
	.uh-chip--link:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}
	.uh-fields {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		border-top: 1px solid var(--border-default);
	}
	.uh-fields > :global(:not(:first-child)) {
		border-left: 1px solid color-mix(in srgb, var(--border-default) 60%, transparent);
	}
	@media (max-width: 640px) {
		.uh-top {
			padding: 1.25rem 1.25rem 1rem;
			gap: 1rem;
		}
		.uh-name {
			font-size: 1.25rem;
		}
		.uh-fields {
			grid-template-columns: 1fr;
		}
		.uh-fields > :global(:not(:first-child)) {
			border-left: none;
			border-top: 1px solid color-mix(in srgb, var(--border-default) 40%, transparent);
		}
	}
</style>
