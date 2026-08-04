<script lang="ts">
	import { PanelLeft, Search } from 'lucide-svelte';
	import { mobileNavOpen, selectedOrganization } from '$lib/stores';
	import { RemoteImg } from '$lib/components/ui';

	let { scrolled = false }: { scrolled?: boolean } = $props();
</script>

<header class="topbar" class:topbar--raised={scrolled}>
	<button
		type="button"
		class="topbar-btn"
		aria-label="Open navigation"
		onclick={() => mobileNavOpen.open()}
	>
		<PanelLeft size={19} />
	</button>
	<span class="topbar-title" aria-hidden={!scrolled}>
		<span class="topbar-org-avatar">
			{#if $selectedOrganization?.avatarUrl}
				<RemoteImg src={$selectedOrganization.avatarUrl} />
			{:else}
				{($selectedOrganization?.name ?? '?').charAt(0)}
			{/if}
		</span>
		<span class="topbar-org-name">{$selectedOrganization?.name ?? 'Orchard'}</span>
	</span>
	<button
		type="button"
		class="topbar-btn"
		aria-label="Search"
		onclick={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
	>
		<Search size={19} />
	</button>
</header>

<style>
	.topbar {
		display: none;
		align-items: center;
		gap: var(--space-1);
		height: 2.75rem;
		padding: 0 var(--space-1);
		flex-shrink: 0;
		position: sticky;
		top: 0;
		z-index: 30;
		background-color: transparent;
		transition:
			background-color var(--dur-base) ease,
			box-shadow var(--dur-base) ease;
	}
	@media (max-width: 899px) {
		.topbar {
			display: flex;
		}
	}
	.topbar--raised {
		background-color: color-mix(in srgb, var(--bg-app) 72%, transparent);
		backdrop-filter: saturate(180%) blur(20px);
		-webkit-backdrop-filter: saturate(180%) blur(20px);
		box-shadow: 0 0.5px 0 var(--rule);
	}
	.topbar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-pill);
		background: none;
		color: var(--accent);
		cursor: pointer;
		padding: 0;
	}
	.topbar-btn:active {
		opacity: 0.5;
	}
	.topbar-title {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		opacity: 0;
		transform: translate3d(0, 6px, 0);
		transition:
			opacity var(--dur-base) ease,
			transform var(--dur-base) var(--ease-out);
	}
	.topbar--raised .topbar-title {
		opacity: 1;
		transform: translate3d(0, 0, 0);
	}
	.topbar-org-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: var(--radius-xs);
		overflow: hidden;
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 700;
		background: var(--fill-medium);
		color: var(--text-muted);
	}
	.topbar-org-avatar :global(img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.topbar-org-name {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	@media (prefers-reduced-motion: reduce) {
		.topbar,
		.topbar-title {
			transition: none;
		}
	}
</style>
