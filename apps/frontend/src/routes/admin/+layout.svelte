<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { isSuperAdmin, isLoaded } from '$lib/stores';
	import {
		Shield,
		Users,
		Building2,
		LayoutDashboard,
		Server,
		Activity,
		Gauge,
		ScrollText
	} from 'lucide-svelte';

	let { children } = $props();

	$effect(() => {
		if ($isLoaded && !$isSuperAdmin) {
			goto('/');
		}
	});

	const tabs = [
		{ href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
		{ href: '/admin/users', label: 'Users', icon: Users, exact: false },
		{ href: '/admin/organizations', label: 'Organizations', icon: Building2, exact: false },
		{ href: '/admin/nodes', label: 'Nodes', icon: Server, exact: false },
		{ href: '/admin/usage', label: 'Usage', icon: Activity, exact: false },
		{ href: '/admin/backfill', label: 'Backfill', icon: Gauge, exact: false },
		{ href: '/admin/audit-logs', label: 'Audit Log', icon: ScrollText, exact: false }
	];

	function isActive(href: string, exact: boolean) {
		if (exact) return $page.url.pathname === href;
		return $page.url.pathname === href || $page.url.pathname.startsWith(href + '/');
	}
</script>

{#if $isSuperAdmin}
	<div class="p-6">
		<div class="mb-6">
			<div class="flex items-center gap-3 mb-4">
				<div
					class="flex h-10 w-10 items-center justify-center rounded-xl"
					style="background-color: var(--primary-100); color: var(--primary-700);"
				>
					<Shield class="h-5 w-5" />
				</div>
				<div>
					<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">
						Admin Panel
					</h1>
					<p class="text-sm" style="color: var(--surface-muted);">
						Manage all users, organizations, and system resources
					</p>
				</div>
			</div>

			<nav
				class="flex gap-1 rounded-2xl border p-1"
				style="border-color: var(--surface-border); background-color: var(--control-bg);"
			>
				{#each tabs as tab (tab.href)}
					<a
						href={tab.href}
						class="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition"
						style={isActive(tab.href, tab.exact)
							? 'background-color: var(--center-channel-bg); color: var(--center-channel-color); box-shadow: 0 1px 3px rgba(0,0,0,0.1);'
							: 'color: var(--surface-muted);'}
					>
						<svelte:component this={tab.icon} class="h-4 w-4" />
						{tab.label}
					</a>
				{/each}
			</nav>
		</div>

		{@render children()}
	</div>
{/if}
