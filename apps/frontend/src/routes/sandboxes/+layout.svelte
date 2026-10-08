<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		GreenhouseShell,
		realEnv,
		type GreenhouseNav,
		type NavTarget
	} from '$lib/components/greenhouse';
	import { SandboxDisabledError, sandboxesQueryOptions } from '$lib/queries/sandboxes';
	import { isSuperAdmin, selectedOrganization, user } from '$lib/stores';

	let { children } = $props();

	const query = createQuery(() => sandboxesQueryOptions($selectedOrganization?.id));

	const listState = $derived(
		query.error instanceof SandboxDisabledError
			? 'disabled'
			: query.isError
				? 'error'
				: query.data
					? 'ready'
					: 'loading'
	);

	const self = $derived(
		$user
			? {
					id: $user.id,
					name:
						[$user.firstName, $user.lastName].filter(Boolean).join(' ') ||
						$user.username ||
						$user.email,
					avatarUrl: $user.imageUrl ?? null
				}
			: null
	);

	const nav: GreenhouseNav = {
		machineId: () => page.params.id ?? null,
		sessionId: () => page.url.searchParams.get('session'),
		tab: () => page.url.searchParams.get('tab'),
		go(target: NavTarget, opts = {}) {
			const machine = target.machine === undefined ? (page.params.id ?? null) : target.machine;
			const params = new URLSearchParams();
			const session =
				target.session === undefined ? page.url.searchParams.get('session') : target.session;
			const tab = target.tab === undefined ? page.url.searchParams.get('tab') : target.tab;
			if (session) params.set('session', session);
			if (session && tab) params.set('tab', tab);
			const search = params.toString();
			const path = machine ? `/sandboxes/${encodeURIComponent(machine)}` : '/sandboxes';
			const next = `${path}${search ? `?${search}` : ''}`;
			if (next === `${page.url.pathname}${page.url.search}`) return;
			void goto(next, { replaceState: opts.replace ?? false, keepFocus: true, noScroll: true });
		}
	};
</script>

<svelte:head>
	<title>Greenhouse</title>
</svelte:head>

<GreenhouseShell
	env={realEnv}
	{nav}
	list={query.data ?? null}
	{listState}
	{self}
	superAdmin={$isSuperAdmin}
	organizationId={$selectedOrganization?.id ?? null}
/>
{@render children()}
