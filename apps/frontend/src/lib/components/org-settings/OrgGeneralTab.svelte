<script lang="ts">
	import { Loader2, Camera, X, Users, Activity, ScrollText, ArrowRight } from 'lucide-svelte';
	import { Pencil as PencilAnim } from 'lucide-svelte';
	import { UserCog, Rocket } from '@jis3r/icons';
	import { fade } from 'svelte/transition';
	import { Avatar as AvatarBuilder } from 'melt/builders';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';
	import { springHover } from '$lib/utils/motion.svelte';

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
</script>

<SettingsSection
	title="Organization"
	description="Manage your organization profile"
	iconColor="primary"
	{index}
>
	{#snippet icon(hovered)}
		<UserCog size={18} animate={hovered} />
	{/snippet}

	<div class="og-hero">
		<div class="og-hero-avatar">
			<div class="og-avatar">
				<img {...orgAvatar.image} alt={organization.name} class="og-avatar-img" />
				<span {...orgAvatar.fallback} class="og-avatar-fallback">
					{organization.name[0]}
				</span>
			</div>
			{#if canEditOrg}
				<input
					bind:this={avatarInputRef}
					type="file"
					accept="image/jpeg,image/png,image/gif,image/webp"
					class="hidden"
					onchange={onUploadAvatar}
				/>
				<button
					onclick={() => avatarInputRef?.click()}
					disabled={uploadingAvatar}
					class="og-avatar-edit"
				>
					{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera
							class="h-3 w-3"
						/>{/if}
				</button>
				{#if organization.avatarUrl}
					<button onclick={onDeleteAvatar} disabled={deletingAvatar} class="og-avatar-remove">
						{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X
								class="h-3 w-3"
							/>{/if}
					</button>
				{/if}
			{/if}
		</div>

		<div class="og-hero-body">
			{#if !isEditing}
				<div class="og-hero-titlerow">
					<div>
						<h2 class="og-hero-name">{organization.name}</h2>
						<p class="og-hero-slug">{organization.slug}</p>
					</div>
					{#if canEditOrg}
						<button onclick={onStartEditing} class="btn btn-ghost btn-sm">
							<PencilAnim class="h-3.5 w-3.5" />
							Edit
						</button>
					{/if}
				</div>
				{#if organization.description}
					<p class="og-hero-desc">{organization.description}</p>
				{/if}
				<div class="og-hero-chips">
					<span class="og-chip">
						<span class="og-chip-label">Your role</span>
						<span class="og-chip-value">{formatRole(currentUserRole || 'member')}</span>
					</span>
					{#if organization?.plan}
						<span class="og-chip">
							<span class="og-chip-label">Plan</span>
							<span class="og-chip-value"
								>{organization.plan.charAt(0).toUpperCase() + organization.plan.slice(1)}</span
							>
						</span>
					{/if}
					{#if organization.members}
						<span class="og-chip">
							<span class="og-chip-label">Members</span>
							<span class="og-chip-value">{organization.members.length}</span>
						</span>
					{/if}
				</div>
			{:else}
				<div class="og-edit-grid" transition:fade={{ duration: 150 }}>
					<div class="og-field">
						<label for="org-name" class="og-field-label">Name</label>
						<input id="org-name" type="text" bind:value={editingName} class="input" />
					</div>
					<div class="og-field">
						<label for="org-desc" class="og-field-label">Description</label>
						<textarea id="org-desc" bind:value={editingDescription} rows="2" class="input"
						></textarea>
					</div>
					<div class="og-edit-actions">
						<button onclick={onCancelEditing} class="btn btn-secondary">Cancel</button>
						<button onclick={onSave} disabled={updating} class="btn btn-primary">
							{#if updating}<Loader2 class="h-4 w-4 animate-spin" />{/if}
							Save
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
</SettingsSection>

<SettingsSection title="Quick Actions" description="Common organization tasks" index={index + 1}>
	{#snippet icon(hovered)}
		<Rocket size={18} animate={hovered} />
	{/snippet}

	<div class="og-quick-actions">
		<a
			class="og-quick-action"
			href={`/${organizationSlug}/usage`}
			{@attach springHover({ lift: -2, stiffness: 340, damping: 24 })}
		>
			<div class="og-quick-action-icon og-quick-action-icon--amber">
				<Activity class="h-4 w-4" />
			</div>
			<div class="og-quick-action-body">
				<p class="og-quick-action-title">Usage & Allowances</p>
				<p class="og-quick-action-desc">Org capacity, per-user limits, provisioning</p>
			</div>
			<ArrowRight class="h-4 w-4 og-quick-action-arrow" />
		</a>
		<a
			class="og-quick-action"
			href={`/${organizationSlug}/settings?tab=members`}
			{@attach springHover({ lift: -2, stiffness: 340, damping: 24 })}
		>
			<div class="og-quick-action-icon og-quick-action-icon--blue">
				<Users class="h-4 w-4" />
			</div>
			<div class="og-quick-action-body">
				<p class="og-quick-action-title">Members</p>
				<p class="og-quick-action-desc">Invite, remove, and change roles</p>
			</div>
			<ArrowRight class="h-4 w-4 og-quick-action-arrow" />
		</a>
		{#if canEditOrg}
			<a
				class="og-quick-action"
				href={`/${organizationSlug}/settings/audit-logs`}
				{@attach springHover({ lift: -2, stiffness: 340, damping: 24 })}
			>
				<div class="og-quick-action-icon og-quick-action-icon--default">
					<ScrollText class="h-4 w-4" />
				</div>
				<div class="og-quick-action-body">
					<p class="og-quick-action-title">Audit log</p>
					<p class="og-quick-action-desc">Recent admin actions in this org</p>
				</div>
				<ArrowRight class="h-4 w-4 og-quick-action-arrow" />
			</a>
		{/if}
	</div>
</SettingsSection>

<style>
	/* Hero layout */
	.og-hero {
		display: flex;
		gap: 1.5rem;
		align-items: flex-start;
	}

	.og-hero-avatar {
		position: relative;
		flex-shrink: 0;
	}

	.og-avatar {
		width: 4.5rem;
		height: 4.5rem;
		border-radius: 1rem;
		overflow: hidden;
		background-color: color-mix(in srgb, var(--center-channel-color) 8%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.og-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.og-avatar-fallback {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--center-channel-color);
		opacity: 0.5;
	}

	.og-avatar-edit,
	.og-avatar-remove {
		position: absolute;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px solid var(--surface-bg);
		cursor: pointer;
		transition: opacity 0.15s ease;
	}

	.og-avatar-edit {
		bottom: -0.25rem;
		right: -0.25rem;
		background-color: var(--button-bg);
		color: var(--button-color);
	}

	.og-avatar-remove {
		top: -0.25rem;
		right: -0.25rem;
		background-color: var(--error-text);
		color: #fff;
	}

	.og-avatar-edit:hover,
	.og-avatar-remove:hover {
		opacity: 0.85;
	}

	.og-avatar-edit:disabled,
	.og-avatar-remove:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Hero body */
	.og-hero-body {
		flex: 1;
		min-width: 0;
	}

	.og-hero-titlerow {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.og-hero-name {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}

	.og-hero-slug {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0.125rem 0 0;
		font-family: var(--font-mono, monospace);
	}

	.og-hero-desc {
		font-size: 0.875rem;
		color: var(--center-channel-color);
		opacity: 0.75;
		margin: 0.75rem 0 0;
		line-height: 1.5;
	}

	/* Chips */
	.og-hero-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.og-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
		font-size: 0.75rem;
	}

	.og-chip-label {
		color: var(--surface-muted);
	}

	.og-chip-value {
		font-weight: 600;
		color: var(--center-channel-color);
	}

	/* Edit mode */
	.og-edit-grid {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.og-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.og-field-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.og-edit-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	/* Quick actions */
	.og-quick-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.og-quick-action {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s ease;
		will-change: transform;
	}

	.og-quick-action:hover {
		border-color: color-mix(in srgb, var(--center-channel-color) 18%, transparent);
	}

	.og-quick-action-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
	}

	.og-quick-action-icon--amber {
		background-color: #fef3c7;
		color: #b45309;
	}

	.og-quick-action-icon--blue {
		background-color: #dbeafe;
		color: #1d4ed8;
	}

	.og-quick-action-icon--default {
		background-color: #e2e8f0;
		color: #475569;
	}

	.og-quick-action-body {
		flex: 1;
		min-width: 0;
	}

	.og-quick-action-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.og-quick-action-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.125rem 0 0;
	}

	:global(.og-quick-action-arrow) {
		flex-shrink: 0;
		color: var(--surface-muted);
		transition: color 0.15s ease;
	}

	.og-quick-action:hover :global(.og-quick-action-arrow) {
		color: var(--center-channel-color);
	}

	/* Responsive */
	@media (max-width: 640px) {
		.og-hero {
			flex-direction: column;
			align-items: center;
			text-align: center;
		}

		.og-hero-titlerow {
			flex-direction: column;
			align-items: center;
		}

		.og-hero-chips {
			justify-content: center;
		}
	}
</style>
