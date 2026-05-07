<script lang="ts">
    import { organizations, selectedOrganization, type Organization } from '$lib/stores';
	import { goto } from '$app/navigation';
	import { Building2 } from 'lucide-svelte';
	import { ChevronsUpDown, X, Settings, FolderKanban } from '@jis3r/icons';
    import { Collapsible } from 'melt/components';
    import { animate } from 'motion';

    interface Props {
        collapsed?: boolean;
    }
    let { collapsed = false }: Props = $props();

    let open = $state(false);
    let render = $state(false);
    $effect(() => { if (open) render = true; });

    function selectOrg(org: Organization) {
        organizations.setSelected(org);
        open = false;
        goto(`/${org.slug}`);
    }

    // IN/OUT spring for the panel.
    function motionPopover(opts: {
        from?: { opacity?: number; scale?: number; y?: number };
        stiffness?: number;
        damping?: number;
        mass?: number;
        closing: () => boolean;
        onClosed: () => void;
    }) {
        const from = {
            opacity: opts.from?.opacity ?? 0,
            scale: opts.from?.scale ?? 0.96,
            y: opts.from?.y ?? -6
        };
        const stiffness = opts.stiffness ?? 520;
        const damping = opts.damping ?? 30;
        const mass = opts.mass ?? 0.85;
        return (el: Element) => {
            const target = el as HTMLElement;
            animate(
                target,
                { opacity: [from.opacity, 1], scale: [from.scale, 1], y: [from.y, 0] },
                { type: 'spring', stiffness, damping, mass }
            );
            let firstRun = true;
            $effect(() => {
                const closing = opts.closing();
                if (firstRun) { firstRun = false; return; }
                if (closing) {
                    animate(
                        target,
                        { opacity: from.opacity, scale: from.scale, y: from.y },
                        { type: 'spring', stiffness: stiffness * 1.1, damping: damping + 6, mass }
                    ).finished.then(() => {
                        if (opts.closing()) opts.onClosed();
                    });
                } else {
                    animate(
                        target,
                        { opacity: 1, scale: 1, y: 0 },
                        { type: 'spring', stiffness, damping, mass }
                    );
                }
            });
        };
    }

    // Stagger nav items on enter.
    function motionStagger(index: number, stride = 0.035) {
        return (el: Element) => {
            const target = el as HTMLElement;
            animate(
                target,
                { opacity: [0, 1], y: [-6, 0] },
                { type: 'spring', stiffness: 320, damping: 26, mass: 0.7, delay: index * stride }
            );
        };
    }

    // Velocity-aware lift.
    function springHover(opts: { lift?: number; stiffness?: number; damping?: number } = {}) {
        const { lift = -1, stiffness = 380, damping = 22 } = opts;
        return (el: Element) => {
            const t = el as HTMLElement;
            const enter = () => {
                animate(t, { y: lift }, { type: 'spring', stiffness, damping });
                t.querySelectorAll('[role="img"]').forEach((icon) => {
                    icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                });
            };
            const leave = () => animate(t, { y: 0 }, { type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 });
            const press = () => animate(t, { scale: 0.97 }, { type: 'spring', stiffness: 600, damping: 28 });
            const release = () => animate(t, { scale: 1 }, { type: 'spring', stiffness: 420, damping: 18 });
            t.addEventListener('mouseenter', enter);
            t.addEventListener('mouseleave', leave);
            t.addEventListener('pointerdown', press);
            t.addEventListener('pointerup', release);
            t.addEventListener('pointerleave', release);
            return () => {
                t.removeEventListener('mouseenter', enter);
                t.removeEventListener('mouseleave', leave);
                t.removeEventListener('pointerdown', press);
                t.removeEventListener('pointerup', release);
                t.removeEventListener('pointerleave', release);
            };
        };
    }

    // Chevron rotation spring.
    function springRotate(active: () => boolean, on = 180) {
        return (el: Element) => {
            const t = el as HTMLElement;
            t.style.transform = `rotate(${active() ? on : 0}deg)`;
            let prev = active();
            $effect(() => {
                const next = active();
                if (next === prev) return;
                prev = next;
                animate(t, { rotate: next ? on : 0 }, { type: 'spring', stiffness: 380, damping: 24, mass: 0.7 });
            });
        };
    }
</script>

<Collapsible bind:open={open}>
	{#snippet children(collapsible)}
		<div class="workspaces-menu" class:is-collapsed={collapsed}>
			{#if collapsed}
				<button
					type="button"
					aria-label="Toggle organization menu"
					{...collapsible.trigger}
					class="org-menu-trigger-collapsed"
					class:is-open={collapsible.open}
					{@attach springHover()}
				>
					{#if $selectedOrganization?.avatarUrl}
						<img
							src={$selectedOrganization.avatarUrl}
							alt={$selectedOrganization.name}
							class="sidebar-org-avatar"
						/>
					{:else}
						<div class="sidebar-org-avatar-fallback">
							<FolderKanban size={16} />
						</div>
					{/if}
					{#if !collapsible.open}
						<span class="sidebar-collapsed-tooltip">
							{$selectedOrganization?.name ?? 'Select organization'}
						</span>
					{/if}
				</button>
			{:else}
				<button
					type="button"
					aria-label="Toggle organization menu"
					{...collapsible.trigger}
					class="org-menu-trigger relative z-10"
					{@attach springHover({ lift: -1 })}
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
					<span
						class="org-menu-trigger-chevron"
						class:is-open={collapsible.open}
						{@attach springRotate(() => !!collapsible.open, 180)}
					>
						{#if collapsible.open}
							<X size={16} />
						{:else}
							<ChevronsUpDown size={16} />
						{/if}
					</span>
				</button>
			{/if}

			{#if render}
				<div
					{...collapsible.content}
					class="org-menu-panel"
					class:org-menu-panel-collapsed={collapsed}
					style:transform-origin="top left"
					{@attach motionPopover({
						from: { y: -8, scale: 0.96 },
						stiffness: 540,
						damping: 30,
						closing: () => !open,
						onClosed: () => { render = false; }
					})}
				>
					<div class="org-menu-list">
						{#each $organizations as org, i}
							<button
								type="button"
								onclick={() => selectOrg(org)}
								class="org-menu-item"
								{@attach motionStagger(i)}
								{@attach springHover({ lift: -1 })}
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
							<a
								href="/{$selectedOrganization.slug}/settings"
								{@attach motionStagger($organizations.length)}
								{@attach springHover({ lift: -1 })}
							>
								<Settings size={16} />
								Organization Settings
							</a>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</Collapsible>
