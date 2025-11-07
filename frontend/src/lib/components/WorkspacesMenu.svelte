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
		<div class="workspaces-menu mx-auto w-full">
			<button
				type="button"
				aria-label="Toggle organization menu"
				{...collapsible.trigger}
				class="org-menu-trigger relative z-10 mx-auto"
				class:shadow-md={collapsible.open}
			>
				<div class="flex items-center gap-3 min-w-0">
					{#if $selectedOrganization}
						{#if $selectedOrganization.avatarUrl}
							<img
								src={$selectedOrganization.avatarUrl}
								alt={$selectedOrganization.name}
								class="h-8 w-8 rounded-lg object-cover"
							/>
						{:else}
							<div
								class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400"
							>
								<Building2 class="h-4 w-4" />
							</div>
						{/if}
						<div class="flex-1 min-w-0 text-left">
							<p class="truncate text-sm font-medium" style="color: var(--sidebar-text);">
								{$selectedOrganization.name}
							</p>
						</div>
					{:else}
						<div
							class="flex h-8 w-8 items-center justify-center rounded-lg"
							style="background-color: var(--sidebar-text-hover-bg); color: var(--sidebar-text);"
						>
							<Building2 class="h-4 w-4" />
						</div>
						<span class="text-sm" style="color: var(--surface-muted);">Select organization</span>
					{/if}
				</div>
				{#if collapsible.open}
					<X class="h-4 w-4" style="color: var(--sidebar-text);" />
				{:else}
					<ChevronsUpDown class="h-4 w-4" style="color: var(--surface-muted);" />
				{/if}
			</button>

			{#if collapsible.open}
				<div
					{...collapsible.content}
					class="org-menu-panel mx-auto w-[calc(100%-32px)]"
					transition:slide
				>
					<div class="flex flex-col gap-2">
						{#each $organizations as org, index}
							<div>
								<button
									type="button"
									onclick={() => selectOrg(org)}
									class="org-menu-item"
								>
									{#if org.avatarUrl}
										<img
											src={org.avatarUrl}
											alt={org.name}
											class="h-6 w-6 rounded object-cover"
										/>
									{:else}
										<div
											class="flex h-6 w-6 items-center justify-center rounded bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400"
										>
											<Building2 class="h-3 w-3" />
										</div>
									{/if}
									<span class="flex-1 truncate text-sm">{org.name}</span>
									{#if $selectedOrganization?.id === org.id}
										<span class="h-2 w-2 rounded-full bg-primary-500"></span>
									{/if}
								</button>
								{#if index < $organizations.length - 1}
									<hr class="org-menu-divider mt-2" />
								{/if}
							</div>
						{/each}
					</div>
					{#if $selectedOrganization}
						<div class="org-menu-footer">
							<a href="/organizations/{$selectedOrganization.slug}/settings">
								<Settings class="h-4 w-4" />
								Organization settings
							</a>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</Collapsible>
