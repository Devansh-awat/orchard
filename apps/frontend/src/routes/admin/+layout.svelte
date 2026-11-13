<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		isSuperAdmin,
		isLoaded,
		instanceChecklist,
		instanceChecklistOutstanding
	} from '$lib/stores';
	import { Badge } from '$lib/components/ui';
	import ResourceHeader from '$lib/components/patterns/ResourceHeader.svelte';
	import SettingsShell from '$lib/components/patterns/SettingsShell.svelte';
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

	const railItem = (href: string, label: string) => ({ id: href, href, label });

	const graftItems = $derived(
		graftHost.slot('admin.nav').map(({ item }) => railItem(item.href, item.label))
	);

	const groups = $derived([
		{
			label: 'Instance',
			items: [
				railItem('/admin', 'Overview'),
				railItem('/admin/instance', 'Configuration'),
				railItem('/admin/networking', 'Networking'),
				railItem('/admin/limits', 'Limits'),
				railItem('/admin/nodes', 'Nodes'),
				railItem('/admin/usage', 'Usage'),
				railItem('/admin/grafts', 'Grafts')
			]
		},
		{
			label: 'People',
			items: [
				railItem('/admin/users', 'Users'),
				railItem('/admin/organizations', 'Organizations'),
				railItem('/admin/sso', 'Sign in')
			]
		},
		{
			label: 'Maintenance',
			items: [
				railItem('/admin/audit-logs', 'Audit log'),
				railItem('/admin/build-cache', 'Build cache'),
				railItem('/admin/backfill', 'Backfill')
			]
		},
		...(graftItems.length ? [{ label: 'Extensions', items: graftItems }] : [])
	]);

	const active = $derived(
		groups
			.flatMap((group) => group.items)
			.filter(
				(item) => $page.url.pathname === item.href || $page.url.pathname.startsWith(`${item.href}/`)
			)
			.sort((a, b) => b.href.length - a.href.length)[0]
	);
</script>

{#if $isSuperAdmin}
	<SettingsShell
		crumbs={[
			{ label: 'Home', href: '/' },
			{ label: 'Instance admin', href: '/admin' },
			{ label: active?.label ?? 'Overview' }
		]}
		{groups}
		activeId={active?.id ?? '/admin'}
		label="Instance admin sections"
	>
		{#snippet header()}
			<ResourceHeader title="Instance admin">
				{#snippet badges()}
					{#if $instanceChecklistOutstanding.length > 0}
						<Badge tone="warning">{$instanceChecklistOutstanding.length} to set up</Badge>
					{/if}
				{/snippet}
			</ResourceHeader>
		{/snippet}
		{@render children()}
	</SettingsShell>
{/if}
