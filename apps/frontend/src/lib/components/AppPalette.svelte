<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { createQuery } from '@tanstack/svelte-query';
	import {
		BookOpen,
		Box,
		Copy,
		Database,
		Gauge,
		LogOut,
		Moon,
		Plus,
		Settings,
		Timer,
		UserPlus
	} from 'lucide-svelte';
	import CommandPalette, {
		type PaletteAction,
		type PaletteItem
	} from '$lib/components/patterns/CommandPalette.svelte';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { jobsQueryOptions } from '$lib/queries/jobs';
	import { resourceStatus, runStatus } from '$lib/components/ui/status';
	import { knownIcon, favUrl, IMG_ICONS } from '$lib/components/org-dashboard/helpers.svelte';
	import { ingressUrl } from '$lib/ingress-url';
	import { selectedOrganization, toasts, user } from '$lib/stores';
	import { themeStore } from '$lib/stores/theme';
	import type { Job } from '$lib/types/jobs';
	import type {
		DeploymentSummary,
		DatabaseSummary,
		ProjectMeta
	} from '$lib/components/org-dashboard';

	let open = $state(false);

	export function openSearch() {
		open = true;
	}

	$effect(() => {
		const on = () => (open = true);
		window.addEventListener('open-quick-search', on);
		return () => window.removeEventListener('open-quick-search', on);
	});

	const orgSlug = $derived($page.params.orgSlug ?? $selectedOrganization?.slug ?? '');

	const overview = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: !!orgSlug
	}));

	const orgId = $derived(
		(overview.data?.organization?.id as string | undefined) ?? $selectedOrganization?.id ?? ''
	);

	const jobs = createQuery(() => ({
		...jobsQueryOptions(orgId),
		enabled: open && !!orgId,
		staleTime: 30_000
	}));

	const isUrl = (v?: string | null) => !!v && /^(https?:)?\/\//.test(v);

	const items = $derived.by<PaletteItem[]>(() => {
		const data = overview.data;
		if (!data || !orgSlug) return [];
		const projects = (data.projects ?? []) as ProjectMeta[];
		const icons = new Map(projects.map((p) => [p.id, isUrl(p.icon) ? (p.icon ?? null) : null]));
		const names = new Map(projects.map((p) => [p.id, p.name]));
		const deployments = (data.deployments ?? []) as DeploymentSummary[];
		const databases = (data.databases ?? []) as DatabaseSummary[];
		const count = (id: string) => {
			const apps = deployments.filter((d) => d.project?.id === id).length;
			const dbs = databases.filter((d) => d.project?.id === id).length;
			return [
				apps && `${apps} app${apps === 1 ? '' : 's'}`,
				dbs && `${dbs} database${dbs === 1 ? '' : 's'}`
			]
				.filter(Boolean)
				.join(' · ');
		};
		return [
			...projects.map((p): PaletteItem => ({
				id: p.id,
				label: p.name,
				sublabel: count(p.id) || undefined,
				kind: 'project',
				icon: icons.get(p.id),
				href: `/${orgSlug}/projects/${p.slug}`
			})),
			...deployments.map((d): PaletteItem => {
				const host = d.ingresses[0]?.host;
				return {
					id: d.id,
					label: d.displayName || d.name,
					sublabel: host ?? d.project?.name,
					kind: 'deployment',
					icon: knownIcon(d.image) ?? d.faviconUrl ?? (host ? favUrl(host.split('/')[0]) : null),
					project: d.project?.name,
					projectIcon: d.project ? icons.get(d.project.id) : null,
					status: resourceStatus(d.status, d.buildStatus),
					href: `/${orgSlug}/deployments/${d.id}`,
					url: d.ingresses[0] ? ingressUrl(d.ingresses[0]) : undefined
				};
			}),
			...databases.map((db): PaletteItem => ({
				id: db.id,
				label: db.name,
				sublabel: db.project?.name,
				kind: 'database',
				icon: IMG_ICONS.postgres,
				project: db.project?.name,
				projectIcon: db.project ? icons.get(db.project.id) : null,
				status: resourceStatus(db.status),
				href: `/${orgSlug}/databases/${db.id}`
			})),
			...((jobs.data ?? []) as Job[]).map((j): PaletteItem => ({
				id: j.id,
				label: j.name,
				sublabel: names.get(j.projectId),
				kind: 'job',
				project: names.get(j.projectId),
				projectIcon: icons.get(j.projectId) ?? null,
				status: j.lastRun ? runStatus(j.lastRun.status) : undefined,
				href: `/${orgSlug}/jobs/${j.id}`
			}))
		];
	});

	const actions = $derived<PaletteAction[]>([
		{
			id: 'new-deployment',
			label: 'New app',
			hint: 'From a repo or an image',
			icon: Box,
			keywords: ['create', 'deploy', 'deployment'],
			run: () => goto(`/${orgSlug}/new`)
		},
		{
			id: 'new-database',
			label: 'New database',
			hint: 'Postgres or Redis',
			icon: Database,
			keywords: ['create', 'postgres', 'redis', 'db'],
			run: () => goto(`/${orgSlug}/new?type=database`)
		},
		{
			id: 'new-job',
			label: 'New job',
			hint: 'Runs on a schedule',
			icon: Timer,
			keywords: ['cron', 'schedule', 'create'],
			run: () => goto(`/${orgSlug}/jobs/new`)
		},
		{
			id: 'new-project',
			label: 'New project',
			icon: Plus,
			keywords: ['create', 'group'],
			run: () => goto(`/${orgSlug}/projects/new`)
		},
		{
			id: 'dark-mode',
			label: 'Toggle dark mode',
			icon: Moon,
			keywords: ['theme', 'light', 'appearance'],
			shortcut: '⌘⇧L',
			run: () => {
				const dark = document.documentElement.classList.contains('dark');
				themeStore.setMode(dark ? 'light' : 'dark');
			}
		},
		...($selectedOrganization?.myRole === 'guest'
			? []
			: [
					{
						id: 'usage',
						label: 'Usage',
						hint: 'CPU, memory and quotas',
						icon: Gauge,
						keywords: ['quota', 'billing', 'resources'],
						run: () => goto(`/${orgSlug}/usage`)
					}
				]),
		{
			id: 'invite',
			label: 'Invite a teammate',
			icon: UserPlus,
			keywords: ['member', 'people', 'team'],
			run: () => goto(`/${orgSlug}/settings?tab=members`)
		},
		{
			id: 'org-settings',
			label: 'Organization settings',
			icon: Settings,
			keywords: ['org', 'sso', 'members', 'billing'],
			run: () => goto(`/${orgSlug}/settings`)
		},
		{
			id: 'account',
			label: 'Account settings',
			icon: Settings,
			keywords: ['profile', 'tokens', 'appearance', 'me'],
			run: () => goto('/user/settings')
		},
		{
			id: 'copy-org',
			label: 'Copy organization ID',
			hint: $selectedOrganization?.name,
			icon: Copy,
			keywords: ['organization', 'id', 'clipboard'],
			run: () => {
				if (!orgId) return;
				navigator.clipboard?.writeText(orgId).catch(() => undefined);
				toasts.add({ title: 'Organization ID copied', color: 'success' });
			}
		},
		{
			id: 'docs',
			label: 'Open docs',
			icon: BookOpen,
			keywords: ['help', 'documentation', 'guide'],
			shortcut: '⌘/',
			run: () => window.open('https://orchard.my/docs', '_blank', 'noopener')
		},
		{
			id: 'sign-out',
			label: 'Sign out',
			icon: LogOut,
			keywords: ['logout', 'leave'],
			run: () => user.signOut()
		}
	]);

	const origin = () =>
		document.querySelector<HTMLElement>('.deck-host .search') ??
		document.querySelector<HTMLElement>('.deck-host');
</script>

<CommandPalette bind:open {origin} {items} {actions} />
