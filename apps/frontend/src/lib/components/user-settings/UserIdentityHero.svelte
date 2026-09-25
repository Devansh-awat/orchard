<script lang="ts">
	import { Loader2, Camera, X, Pencil } from 'lucide-svelte';
	import { Eye, EyeOff } from '@jis3r/icons';
	import { motionStagger, iconAnimation } from '$lib/utils/motion.svelte';
	import { Button, Field, Input, Modal } from '$lib/components/ui';
	import { avatarUrl } from '$lib/avatar';

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
		isEditing = $bindable(false),
		editFirstName = $bindable(''),
		editLastName = $bindable(''),
		editUsername = $bindable(''),
		saving,
		uploadingAvatar,
		deletingAvatar,
		onStartEditing,
		onCancelEditing,
		onSave,
		onUploadAvatar,
		onDeleteAvatar,
		avatarInputRef = $bindable<HTMLInputElement | undefined>(undefined),
		passkeyCount = null,
		sessionCount = null,
		githubLinked = false,
		index = 0
	}: {
		user: UserData | null;
		displayEmail: string;
		emailRevealed: boolean;
		isEditing: boolean;
		editFirstName: string;
		editLastName: string;
		editUsername: string;
		saving: boolean;
		uploadingAvatar: boolean;
		deletingAvatar: boolean;
		onStartEditing: () => void;
		onCancelEditing: () => void;
		onSave: () => void;
		onUploadAvatar: (event: Event) => void;
		onDeleteAvatar: () => void;
		avatarInputRef?: HTMLInputElement | undefined;
		passkeyCount?: number | null;
		sessionCount?: number | null;
		githubLinked?: boolean;
		index?: number;
	} = $props();

	let revealHovered = $state(false);
	const revealAnim = $derived(iconAnimation(revealHovered));

	const displayName = $derived(
		[user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
			user?.name ||
			user?.username ||
			'You'
	);

	const chips = $derived(
		[
			passkeyCount !== null && {
				id: 'passkeys',
				href: '/user/settings?tab=security',
				valueFirst: true,
				value: String(passkeyCount),
				label: `passkey${passkeyCount === 1 ? '' : 's'}`
			},
			sessionCount !== null && {
				id: 'sessions',
				href: '/user/settings?tab=security',
				valueFirst: true,
				value: String(sessionCount),
				label: `device${sessionCount === 1 ? '' : 's'}`
			},
			{
				id: 'github',
				href: '/user/settings?tab=connections',
				valueFirst: false,
				label: 'GitHub',
				value: githubLinked ? 'Connected' : 'Not connected'
			}
		].filter(Boolean) as {
			id: string;
			href: string;
			valueFirst: boolean;
			value: string;
			label: string;
		}[]
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

<section class="uh-root" {@attach motionStagger({ index, from: { y: 12, opacity: 0 } })}>
	<div class="uh-top">
		<div class="uh-avatar-wrap">
			<div class="uh-avatar">
				<img src={avatarUrl(user)} alt={displayName} class="uh-avatar-img" />
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
			<div class="uh-titlerow">
				<div class="uh-titlegroup">
					<h2 class="uh-name">{displayName}</h2>
					<p class="uh-sub">
						{#if user?.username}<span class="uh-username">{user.username}</span>
							<span class="uh-dot">·</span>{/if}
						<span class="uh-email-wrap">
							<span class="uh-email">{displayEmail}</span>
							<button
								type="button"
								class="uh-reveal"
								onclick={() => (emailRevealed = !emailRevealed)}
								aria-label={emailRevealed ? 'Hide email' : 'Show email'}
								onmouseenter={() => (revealHovered = true)}
								onmouseleave={() => (revealHovered = false)}
							>
								{#if emailRevealed}<EyeOff size={13} animate={revealAnim} />{:else}<Eye
										size={13}
										animate={revealAnim}
									/>{/if}
							</button>
						</span>
					</p>
				</div>
				<Button variant="ghost" size="sm" onclick={onStartEditing}>
					<Pencil class="h-3.5 w-3.5" />
					Edit
				</Button>
			</div>
			<div class="uh-chips">
				{#each chips as chip (chip.id)}
					<a class="uh-chip" href={chip.href}>
						{#if chip.valueFirst}
							<span class="uh-chip-value">{chip.value}</span>
							<span class="uh-chip-label">{chip.label}</span>
						{:else}
							<span class="uh-chip-label">{chip.label}</span>
							<span class="uh-chip-value">{chip.value}</span>
						{/if}
					</a>
				{/each}
			</div>
		</div>
	</div>
</section>

<Modal bind:open={isEditing} size="sm" title="Edit profile" onclose={onCancelEditing}>
	<div class="uh-form">
		<div class="uh-form-row">
			<Field label="First name" for="uh-first-name">
				<Input id="uh-first-name" name="firstName" bind:value={editFirstName} />
			</Field>
			<Field label="Last name" for="uh-last-name">
				<Input id="uh-last-name" name="lastName" bind:value={editLastName} />
			</Field>
		</div>
		<Field label="Username" for="uh-username" hint="Used in URLs and mentions">
			<Input id="uh-username" name="username" bind:value={editUsername} />
		</Field>
	</div>

	{#snippet footer()}
		<Button variant="secondary" onclick={onCancelEditing}>Cancel</Button>
		<Button variant="primary" onclick={onSave} loading={saving}>Save</Button>
	{/snippet}
</Modal>

<style>
	.uh-sr-only {
		position: absolute;
		width: 0;
		height: 0;
		opacity: 0;
		pointer-events: none;
	}
	.uh-root {
		border: none;
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
	}
	.uh-top {
		display: flex;
		align-items: flex-start;
		gap: 1.375rem;
		padding: var(--space-6) 1.75rem;
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
		border-radius: var(--radius-xl);
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
	.uh-avatar-actions {
		position: absolute;
		bottom: -0.25rem;
		right: -0.25rem;
		display: flex;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity var(--dur-fast);
	}
	.uh-avatar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		border: 1.5px solid var(--bg-raised);
		background-color: var(--accent);
		color: var(--text-on-accent);
		cursor: pointer;
		transition: opacity var(--dur-fast);
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
	.uh-titlerow {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.uh-titlegroup {
		min-width: 0;
	}
	.uh-name {
		font-size: var(--text-title-1);
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
		flex-wrap: wrap;
		gap: 0.5rem;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		margin: 0.25rem 0 0;
		min-width: 0;
	}
	.uh-username {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}
	.uh-dot {
		color: var(--text-faint);
	}
	.uh-email-wrap {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}
	.uh-email {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.uh-reveal {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.5rem;
		min-height: 1.5rem;
		padding: 0.25rem;
		border-radius: var(--radius-xs);
		color: var(--text-muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: color var(--dur-fast);
	}
	.uh-reveal:hover {
		color: var(--text-default);
	}
	.uh-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.875rem;
	}
	.uh-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		background-color: var(--bg-sunken);
		border: 1px solid color-mix(in srgb, var(--border-default) 70%, transparent);
		border-radius: var(--radius-pill);
		padding: 0.25rem 0.5rem;
		text-decoration: none;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.uh-chip:hover {
		background-color: var(--bg-hover);
	}
	.uh-chip-label {
		color: var(--text-muted);
	}
	.uh-chip-value {
		font-weight: 600;
		color: var(--text-default);
	}
	.uh-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.uh-form-row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}
	@media (max-width: 640px) {
		.uh-top {
			padding: var(--space-5);
			gap: var(--space-4);
		}
		.uh-name {
			font-size: var(--text-title-3);
			line-height: var(--lh-title-3);
			white-space: normal;
		}
		.uh-sub {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.125rem;
		}
		.uh-dot {
			display: none;
		}
		.uh-form-row {
			grid-template-columns: 1fr;
		}
	}
</style>
