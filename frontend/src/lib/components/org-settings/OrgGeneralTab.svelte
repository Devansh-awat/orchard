<script lang="ts">
	import { Loader2, Pencil, Camera, X, Users, Activity, ScrollText, ArrowRight } from 'lucide-svelte';
	import { fade } from 'svelte/transition';
	import { Avatar as AvatarBuilder } from 'melt/builders';

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
	} = $props();

	function formatRole(role: string) {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}

	const orgAvatar = new AvatarBuilder({
		src: () => organization?.avatarUrl,
		delayMs: 120
	});
</script>

<h1 class="os-tab-title">General</h1>

<div class="os-card">
	<div class="org-hero">
		<div class="org-hero-avatar">
			<div class="os-avatar org-hero-avatar-img">
				<img {...orgAvatar.image} alt={organization.name} class="os-avatar-img" />
				<span {...orgAvatar.fallback} class="os-avatar-fallback">
					{organization.name[0]}
				</span>
			</div>
			{#if canEditOrg}
				<input bind:this={avatarInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden" onchange={onUploadAvatar} />
				<button onclick={() => avatarInputRef?.click()} disabled={uploadingAvatar} class="os-avatar-edit">
					{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera class="h-3 w-3" />{/if}
				</button>
				{#if organization.avatarUrl}
					<button onclick={onDeleteAvatar} disabled={deletingAvatar} class="os-avatar-remove">
						{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X class="h-3 w-3" />{/if}
					</button>
				{/if}
			{/if}
		</div>

		<div class="org-hero-body">
			{#if !isEditing}
				<div class="org-hero-titlerow">
					<div>
						<h2 class="org-hero-name">{organization.name}</h2>
						<p class="org-hero-slug">{organization.slug}</p>
					</div>
					{#if canEditOrg}
						<button onclick={onStartEditing} class="btn btn-ghost btn-sm">
							<Pencil class="h-3.5 w-3.5" />
							Edit
						</button>
					{/if}
				</div>
				{#if organization.description}
					<p class="org-hero-desc">{organization.description}</p>
				{/if}
				<div class="org-hero-chips">
					<span class="org-chip">
						<span class="org-chip-label">Your role</span>
						<span class="org-chip-value">{formatRole(currentUserRole || 'member')}</span>
					</span>
					{#if organization?.plan}
						<span class="org-chip">
							<span class="org-chip-label">Plan</span>
							<span class="org-chip-value">{organization.plan.charAt(0).toUpperCase() + organization.plan.slice(1)}</span>
						</span>
					{/if}
					{#if organization.members}
						<span class="org-chip">
							<span class="org-chip-label">Members</span>
							<span class="org-chip-value">{organization.members.length}</span>
						</span>
					{/if}
				</div>
			{:else}
				<div class="os-edit-grid" transition:fade={{ duration: 150 }}>
					<div class="os-field">
						<label for="org-name" class="os-field-label">Name</label>
						<input id="org-name" type="text" bind:value={editingName} class="input" />
					</div>
					<div class="os-field">
						<label for="org-desc" class="os-field-label">Description</label>
						<textarea id="org-desc" bind:value={editingDescription} rows="2" class="input"></textarea>
					</div>
					<div class="os-edit-actions">
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
</div>

<!-- Quick actions -->
<div class="quick-actions">
	<a class="quick-action" href={`/${organizationSlug}/usage`}>
		<div class="quick-action-icon" style="background-color: #fef3c7; color: #b45309;">
			<Activity class="h-4 w-4" />
		</div>
		<div class="quick-action-body">
			<p class="quick-action-title">Usage & Allowances</p>
			<p class="quick-action-desc">Org capacity, per-user limits, provisioning</p>
		</div>
		<ArrowRight class="h-4 w-4 quick-action-arrow" />
	</a>
	<a class="quick-action" href={`/${organizationSlug}/settings?tab=members`}>
		<div class="quick-action-icon" style="background-color: #dbeafe; color: #1d4ed8;">
			<Users class="h-4 w-4" />
		</div>
		<div class="quick-action-body">
			<p class="quick-action-title">Members</p>
			<p class="quick-action-desc">Invite, remove, and change roles</p>
		</div>
		<ArrowRight class="h-4 w-4 quick-action-arrow" />
	</a>
	{#if canEditOrg}
		<a class="quick-action" href={`/${organizationSlug}/settings/audit-logs`}>
			<div class="quick-action-icon" style="background-color: #e2e8f0; color: #475569;">
				<ScrollText class="h-4 w-4" />
			</div>
			<div class="quick-action-body">
				<p class="quick-action-title">Audit log</p>
				<p class="quick-action-desc">Recent admin actions in this org</p>
			</div>
			<ArrowRight class="h-4 w-4 quick-action-arrow" />
		</a>
	{/if}
</div>
