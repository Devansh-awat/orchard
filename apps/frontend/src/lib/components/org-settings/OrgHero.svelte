<script lang="ts">
	import { Loader2, Camera, X, Pencil } from 'lucide-svelte';
	import { Avatar as AvatarBuilder } from 'melt/builders';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { fade } from '$lib/utils/transitions';
	import { Button, Input } from '$lib/components/ui';

	interface Organization {
		id: string;
		name: string;
		slug: string;
		description?: string;
		avatarUrl?: string;
		plan?: string;
		members?: unknown[];
	}

	let {
		organization,
		organizationSlug,
		currentUserRole,
		canEditOrg,
		pendingInvites = 0,
		isEditing = $bindable(false),
		editingName = $bindable(''),
		editingDescription = $bindable(''),
		updating,
		uploadingAvatar,
		deletingAvatar,
		onStartEditing,
		onCancelEditing,
		onSave,
		onUploadAvatar,
		onDeleteAvatar,
		avatarInputRef = $bindable<HTMLInputElement | undefined>(undefined),
		index = 0
	}: {
		organization: Organization;
		organizationSlug: string;
		currentUserRole: string | null;
		canEditOrg: boolean;
		pendingInvites?: number;
		isEditing: boolean;
		editingName: string;
		editingDescription: string;
		updating: boolean;
		uploadingAvatar: boolean;
		deletingAvatar: boolean;
		onStartEditing: () => void;
		onCancelEditing: () => void;
		onSave: () => void;
		onUploadAvatar: (event: Event) => void;
		onDeleteAvatar: () => void;
		avatarInputRef?: HTMLInputElement | undefined;
		index?: number;
	} = $props();

	function formatRole(role: string) {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}

	const orgAvatar = new AvatarBuilder({
		src: () => organization?.avatarUrl,
		delayMs: 120
	});

	const memberCount = $derived(organization.members?.length ?? 0);
</script>

<section
	class="oh-root"
	{@attach motionStagger({ index, stride: 0.06, from: { y: 12, opacity: 0, scale: 0.985 } })}
>
	<div class="oh-top">
		<div class="oh-avatar-wrap">
			<div class="oh-avatar">
				<img {...orgAvatar.image} alt={organization.name} class="oh-avatar-img" />
				<span {...orgAvatar.fallback} class="oh-avatar-fallback">{organization.name[0]}</span>
			</div>
			{#if canEditOrg}
				<input
					bind:this={avatarInputRef}
					type="file"
					accept="image/jpeg,image/png,image/gif,image/webp"
					class="oh-sr-only"
					aria-label="Upload organization logo"
					onchange={onUploadAvatar}
				/>
				<div class="oh-avatar-actions">
					<button
						type="button"
						class="oh-avatar-btn"
						onclick={() => avatarInputRef?.click()}
						disabled={uploadingAvatar}
						title="Upload logo"
						aria-label="Upload logo"
					>
						{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera
								class="h-3 w-3"
							/>{/if}
					</button>
					{#if organization.avatarUrl}
						<button
							type="button"
							class="oh-avatar-btn oh-avatar-btn--danger"
							onclick={onDeleteAvatar}
							disabled={deletingAvatar}
							title="Remove logo"
							aria-label="Remove logo"
						>
							{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X
									class="h-3 w-3"
								/>{/if}
						</button>
					{/if}
				</div>
			{/if}
		</div>

		<div class="oh-id">
			{#if !isEditing}
				<div class="oh-titlerow">
					<div class="oh-titlegroup">
						<h1 class="oh-name">{organization.name}</h1>
						<p class="oh-slug">{organization.slug}</p>
					</div>
					{#if canEditOrg}
						<Button variant="ghost" size="sm" onclick={onStartEditing}>
							<Pencil class="h-3.5 w-3.5" />
							Edit
						</Button>
					{/if}
				</div>
				{#if organization.description}
					<p class="oh-desc">{organization.description}</p>
				{/if}
				<div class="oh-chips">
					<span class="oh-chip">
						<span class="oh-chip-label">Your role</span>
						<span class="oh-chip-value">{formatRole(currentUserRole || 'member')}</span>
					</span>
					{#if organization.plan}
						<span class="oh-chip">
							<span class="oh-chip-label">Plan</span>
							<span class="oh-chip-value">{formatRole(organization.plan)}</span>
						</span>
					{/if}
					<a class="oh-chip oh-chip--link" href={`/${organizationSlug}/settings?tab=members`}>
						<span class="oh-chip-value">{memberCount}</span>
						<span class="oh-chip-label">member{memberCount === 1 ? '' : 's'}</span>
					</a>
					{#if pendingInvites > 0}
						<a class="oh-chip oh-chip--link" href={`/${organizationSlug}/settings?tab=members`}>
							<span class="oh-chip-value">{pendingInvites}</span>
							<span class="oh-chip-label">pending invite{pendingInvites === 1 ? '' : 's'}</span>
						</a>
					{/if}
				</div>
			{:else}
				<div class="oh-edit" transition:fade={{ duration: 150 }}>
					<div class="oh-field">
						<label for="oh-org-name" class="oh-field-label">Name</label>
						<Input id="oh-org-name" name="name" bind:value={editingName} />
					</div>
					<div class="oh-field">
						<label for="oh-org-desc" class="oh-field-label">Description</label>
						<textarea
							id="oh-org-desc"
							name="description"
							rows="2"
							class="oh-textarea"
							bind:value={editingDescription}
						></textarea>
					</div>
					<div class="oh-edit-actions">
						<Button variant="secondary" size="sm" onclick={onCancelEditing}>Cancel</Button>
						<Button variant="primary" size="sm" onclick={onSave} loading={updating}>Save</Button>
					</div>
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.oh-sr-only {
		position: absolute;
		width: 0;
		height: 0;
		opacity: 0;
		pointer-events: none;
	}
	.oh-root {
		border: 1px solid var(--border-default);
		border-radius: 1rem;
		background-color: var(--bg-surface);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		overflow: hidden;
	}
	.oh-top {
		display: flex;
		align-items: flex-start;
		gap: 1.375rem;
		padding: 1.75rem;
	}
	.oh-avatar-wrap {
		position: relative;
		flex-shrink: 0;
	}
	.oh-avatar-wrap:hover .oh-avatar-actions {
		opacity: 1;
	}
	.oh-avatar {
		width: 4.5rem;
		height: 4.5rem;
		border-radius: 1.125rem;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 14%, transparent),
			color-mix(in srgb, var(--accent) 5%, transparent)
		);
		outline: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
		outline-offset: 3px;
	}
	.oh-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.oh-avatar-fallback {
		font-size: 1.625rem;
		font-weight: 700;
		color: var(--accent);
	}
	.oh-avatar-actions {
		position: absolute;
		bottom: -0.25rem;
		right: -0.25rem;
		display: flex;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity 150ms;
	}
	.oh-avatar-btn {
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
	.oh-avatar-btn:hover:not(:disabled) {
		opacity: 0.85;
	}
	.oh-avatar-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.oh-avatar-btn--danger {
		background-color: var(--status-error);
	}
	.oh-id {
		flex: 1;
		min-width: 0;
	}
	.oh-titlerow {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.oh-titlegroup {
		min-width: 0;
	}
	.oh-name {
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
	.oh-slug {
		font-size: 0.75rem;
		font-family: var(--font-mono, monospace);
		color: var(--text-muted);
		margin: 0.25rem 0 0;
	}
	.oh-desc {
		font-size: 0.875rem;
		color: var(--text-muted);
		line-height: 1.5;
		margin: 0.625rem 0 0;
	}
	.oh-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.875rem;
	}
	.oh-chip {
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
		text-decoration: none;
	}
	.oh-chip-label {
		color: var(--text-muted);
	}
	.oh-chip-value {
		font-weight: 650;
		color: var(--text-default);
	}
	.oh-chip--link {
		cursor: pointer;
		transition:
			color 120ms,
			background-color 120ms;
	}
	.oh-chip--link:hover {
		background-color: var(--bg-hover);
	}
	.oh-edit {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}
	.oh-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.oh-field-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-default);
	}
	.oh-textarea {
		width: 100%;
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border-default);
		background-color: var(--bg-surface);
		color: var(--text-default);
		font-size: 0.875rem;
		line-height: 1.5;
		resize: vertical;
		transition:
			border-color 150ms ease,
			box-shadow 150ms ease;
	}
	.oh-textarea:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.oh-edit-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}
	@media (max-width: 640px) {
		.oh-top {
			padding: 1.25rem;
			gap: 1rem;
		}
		.oh-name {
			font-size: 1.25rem;
			white-space: normal;
		}
	}
</style>
