<script lang="ts">
    import { organizations, selectedOrganization, type Organization } from '$lib/stores';
	import { ChevronsUpDown, X, Settings, Building2 } from 'lucide-svelte';
    import { Collapsible } from 'melt/components';
    import { slide } from 'svelte/transition';

    let open = $state(false);

    function selectOrg(org: Organization) {
        organizations.setSelected(org);
        open = false;
    }
</script>

<Collapsible bind:open={open}>
	{#snippet children(collapsible)}
		<div class="workspaces-menu">
			<button
				type="button"
				aria-label="Toggle organization menu"
				{...collapsible.trigger}
				class="org-menu-trigger relative z-10"
			>
				<div class="flex items-center gap-3 min-w-0 flex-1">
					{#if $selectedOrganization}
						{#if $selectedOrganization.avatarUrl}
							<img
								src={$selectedOrganization.avatarUrl}
								alt={$selectedOrganization.name}
								class="org-menu-trigger-avatar"
							/>
						{:else}
							<div class="org-menu-trigger-icon">
								<Building2 class="h-4 w-4" />
							</div>
						{/if}
						<span class="org-menu-trigger-name">{$selectedOrganization.name}</span>
					{:else}
						<div class="org-menu-trigger-icon">
							<Building2 class="h-4 w-4" />
						</div>
						<span class="org-menu-trigger-placeholder">Select organization</span>
					{/if}
				</div>
				<span class="org-menu-trigger-chevron" class:is-open={collapsible.open}>
					{#if collapsible.open}
						<X class="h-4 w-4" />
					{:else}
						<ChevronsUpDown class="h-4 w-4" />
					{/if}
				</span>
			</button>

			{#if collapsible.open}
				<div
					{...collapsible.content}
					class="org-menu-panel"
					transition:slide
				>
					<div class="org-menu-list">
						{#each $organizations as org}
							<button
								type="button"
								onclick={() => selectOrg(org)}
								class="org-menu-item"
							>
								{#if org.avatarUrl}
									<img
										src={org.avatarUrl}
										alt={org.name}
										class="org-menu-item-avatar"
									/>
								{:else}
									<div class="org-menu-item-icon">
										<Building2 class="h-3 w-3" />
									</div>
								{/if}
								<span class="org-menu-item-name">{org.name}</span>
								{#if $selectedOrganization?.id === org.id}
									<span class="org-menu-item-dot"></span>
								{/if}
							</button>
						{/each}
					</div>
					{#if $selectedOrganization}
						<div class="org-menu-footer">
							<a href="/organizations/{$selectedOrganization.slug}/settings">
								<Settings class="h-4 w-4" />
								Organization Settings
							</a>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</Collapsible>
