<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		isSuperAdmin,
		isLoaded,
		instanceChecklist,
		instanceChecklistOutstanding
	} from '$lib/stores';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import {
		Users,
		Building2,
		LayoutDashboard,
		SlidersHorizontal,
		Server,
		Globe,
		KeyRound,
		Activity,
		Gauge,
		ScrollText,
		Puzzle
	} from 'lucide-svelte';
	import GraftIcon from '$lib/grafts/GraftIcon.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';

	let { children } = $props();

	$effect(() => {
		if ($isLoaded && !$isSuperAdmin) goto('/');
	});

	$effect(() => {
		if ($isSuperAdmin) instanceChecklist.load();
	});

	$effect(() => {
		if ($isSuperAdmin) void graftHost.load();
	});

	type AdminItem = {
		href: string;
		label: string;
		icon: typeof Users | null;
		exact: boolean;
		graftIcon?: { icon?: string; assetBase: string };
	};

	const graftItems: AdminItem[] = $derived(
		graftHost.slot('admin.nav').map(({ host, item }) => ({
			href: item.href,
			label: item.label,
			icon: null,
			exact: false,
			graftIcon: { icon: item.icon, assetBase: host.graft.assetBase }
		}))
	);

	const groups: { label: string; items: AdminItem[] }[] = $derived([
		{
			label: 'Instance',
			items: [
				{ href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
				{ href: '/admin/instance', label: 'Configuration', icon: SlidersHorizontal, exact: false },
				{ href: '/admin/networking', label: 'Networking', icon: Globe, exact: false },
				{ href: '/admin/nodes', label: 'Nodes', icon: Server, exact: false },
				{ href: '/admin/usage', label: 'Usage', icon: Activity, exact: false },
				{ href: '/admin/grafts', label: 'Grafts', icon: Puzzle, exact: false }
			]
		},
		{
			label: 'People',
			items: [
				{ href: '/admin/users', label: 'Users', icon: Users, exact: false },
				{ href: '/admin/organizations', label: 'Organizations', icon: Building2, exact: false },
				{ href: '/admin/sso', label: 'Sign in', icon: KeyRound, exact: false }
			]
		},
		{
			label: 'Maintenance',
			items: [
				{ href: '/admin/audit-logs', label: 'Audit log', icon: ScrollText, exact: false },
				{ href: '/admin/backfill', label: 'Backfill', icon: Gauge, exact: false }
			]
		},
		...(graftItems.length ? [{ label: 'Extensions', items: graftItems }] : [])
	]);

	function isActive(href: string, exact: boolean) {
		if (exact) return $page.url.pathname === href;
		return $page.url.pathname === href || $page.url.pathname.startsWith(`${href}/`);
	}
</script>

{#if $isSuperAdmin}
	<div class="admin">
		<aside class="admin-nav">
			<div class="admin-brand">
				<p class="admin-brand-title">Instance</p>
				<p class="admin-brand-sub">Settings that apply to everyone here</p>
			</div>

			{#each groups as group, g (group.label)}
				<div class="admin-group" {@attach motionStagger({ index: g })}>
					<p class="admin-group-label">{group.label}</p>
					{#each group.items as item (item.href)}
						<a
							href={item.href}
							class="admin-link"
							class:admin-link--active={isActive(item.href, item.exact)}
							aria-current={isActive(item.href, item.exact) ? 'page' : undefined}
						>
							{#if item.icon}
								<item.icon size={15} />
							{:else if item.graftIcon}
								<GraftIcon icon={item.graftIcon.icon} assetBase={item.graftIcon.assetBase} />
							{/if}
							<span class="admin-link-label" title={item.label}>{item.label}</span>
							{#if item.href === '/admin' && $instanceChecklistOutstanding.length > 0}
								<span class="admin-count">{$instanceChecklistOutstanding.length}</span>
							{/if}
						</a>
					{/each}
				</div>
			{/each}
		</aside>

		<main class="admin-body">
			{@render children()}
		</main>
	</div>
{/if}

<style>
	.admin {
		display: grid;
		grid-template-columns: 14rem minmax(0, 1fr);
		gap: 2rem;
		align-items: start;
		padding: 1.75rem;
		max-width: 78rem;
	}

	.admin-nav {
		position: sticky;
		top: 1.75rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.admin-brand-title {
		font-size: var(--text-title-3);
		font-weight: 650;
		color: var(--text-fg);
	}

	.admin-brand-sub {
		margin-top: 0.15rem;
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--text-faint);
	}

	.admin-group {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.admin-group-label {
		padding: 0 0.6rem;
		margin-bottom: 0.35rem;
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.admin-link {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius-md);
		font-size: var(--text-callout);
		font-weight: 500;
		color: var(--text-muted);
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.admin-link :global(svg),
	.admin-link :global(img) {
		flex-shrink: 0;
	}

	.admin-link-label {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.admin-link:hover {
		background-color: var(--bg-hover);
		color: var(--text-fg);
	}

	.admin-link--active {
		background-color: var(--accent-subtle);
		color: var(--accent);
	}

	.admin-count {
		margin-left: auto;
		font-size: var(--text-micro);
		font-weight: 600;
		line-height: 1;
		padding: 0.2rem 0.4rem;
		border-radius: var(--radius-pill);
		background-color: var(--status-warning);
		color: var(--bg-surface);
	}

	.admin-body {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
	}

	@media (max-width: 60rem) {
		.admin {
			grid-template-columns: minmax(0, 1fr);
			gap: 1.25rem;
			padding: 1rem;
		}

		.admin-nav {
			position: static;
			flex-direction: row;
			flex-wrap: wrap;
			gap: 0.75rem;
		}

		.admin-brand {
			flex-basis: 100%;
		}

		.admin-group {
			flex-direction: row;
			flex-wrap: wrap;
		}

		.admin-group-label {
			display: none;
		}
	}
</style>
