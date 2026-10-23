import { Sprout, Timer, Gauge, Leaf, TreeDeciduous } from 'lucide-svelte';
import { resourceStatus, buildStatusMeta } from '$lib/components/ui/status';
import type { SidebarSection } from '$lib/components/patterns/sidebar';
import type { BuildItem } from '$lib/components/patterns/builds';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export const PROJECTS = [
	{
		id: 'p1',
		name: 'hackclub-site',
		image: 'https://assets.orchard.my/project-icons/0619ec20-62fc-44e0-9f97-17bb4a5da550.png' as
			| string
			| null,
		background: null as string | null,
		owner: 'kai',
		counts: ['2 deployments', '1 database'],
		entities: [
			{
				kind: 'deployment' as const,
				name: 'web',
				status: resourceStatus('running'),
				url: 'hackclub-site.orchard.my',
				detail: 'main · 4f2a9c1',
				metrics: '118m · 1.9 GiB',
				updatedAt: ago(3)
			},
			{
				kind: 'deployment' as const,
				name: 'api',
				status: resourceStatus('running', 'building'),
				url: 'api.hackclub-site.orchard.my',
				detail: 'main · b81e0d4',
				metrics: undefined as string | undefined,
				updatedAt: ago(0.3)
			},
			{
				kind: 'database' as const,
				name: 'postgres',
				status: resourceStatus('running'),
				detail: 'Postgres 16 · 2.1 GB',
				updatedAt: ago(60 * 26)
			}
		]
	},
	{
		id: 'p2',
		name: 'terra',
		image: 'https://assets.orchard.my/project-icons/f01ab01c-3801-488b-8ad1-256d707f935d.gif' as
			| string
			| null,
		background:
			'https://assets.orchard.my/project-backgrounds/82672415-a9cd-437f-b2f8-f4571e5306fa.png' as
				| string
				| null,
		owner: 'olive',
		counts: ['1 deployment', '1 job'],
		entities: [
			{
				kind: 'deployment' as const,
				name: 'worker',
				status: resourceStatus('crashing'),
				url: 'worker-arcade-leaderboard.orchard.my',
				detail: 'Exited with code 137 · out of memory',
				updatedAt: ago(12)
			},
			{
				kind: 'job' as const,
				name: 'nightly-sync',
				status: resourceStatus('stopped'),
				detail: 'Every day at 03:00',
				updatedAt: ago(60 * 9)
			}
		]
	}
];

export const BUILDS = [
	{
		id: 'b1',
		name: 'api',
		commit: 'Bump prisma to 6.4',
		status: buildStatusMeta('building'),
		at: ago(0.3)
	},
	{
		id: 'b2',
		name: 'web',
		commit: 'Fix navbar overflow on mobile',
		status: buildStatusMeta('succeeded'),
		at: ago(3)
	},
	{
		id: 'b3',
		name: 'worker',
		commit: 'Stream results instead of buffering',
		status: buildStatusMeta('failed'),
		at: ago(14)
	},
	{
		id: 'b4',
		name: 'web',
		commit: 'Add sponsors section',
		status: buildStatusMeta('succeeded'),
		at: ago(60 * 5)
	}
];

export const SIDEBAR = {
	org: { name: 'YSWS', plan: 'Enterprise' },
	user: { handle: 'seb' },
	failing: [
		{
			label: 'terra-game-server',
			href: '#',
			reason: 'Crash loop · exit 137 out of memory',
			at: ago(4)
		},
		{ label: 'terra-api', href: '#', reason: 'Health check failing on /healthz', at: ago(11) },
		{ label: 'worker', href: '#', reason: 'Build failed · dependency install', at: ago(14) }
	],
	sections(active: string): SidebarSection[] {
		return [
			{
				label: 'Platform',
				items: [
					{ label: 'Your Apps', href: '#', icon: Sprout, active: active === 'apps' },
					{ label: 'Jobs', href: '#', icon: Timer },
					{ label: 'Usage', href: '#', icon: Gauge },
					{ label: 'Greenhouse', href: '#', icon: Leaf },
					{ label: 'The Grove', href: '#', icon: TreeDeciduous, active: active === 'settings' }
				]
			},
			{
				label: 'Pinned',
				tiles: true,
				items: [
					{ label: 'hackclub-site', href: '#', status: resourceStatus('running') },
					{ label: 'terra-client', href: '#', status: resourceStatus('running', 'building') }
				]
			}
		];
	}
};

export const BUILD_FEED: BuildItem[] = [
	{
		id: 'f1',
		app: 'api',
		message: 'Bump prisma to 6.4',
		status: buildStatusMeta('building'),
		at: ago(0.5),
		branch: 'main',
		progress: 0.62,
		href: '#'
	},
	{
		id: 'f2',
		app: 'web',
		message: 'Fix navbar overflow on mobile',
		status: buildStatusMeta('succeeded'),
		at: ago(3),
		branch: 'main',
		duration: '41s',
		href: '#'
	},
	{
		id: 'f3',
		app: 'worker',
		message: 'Stream results instead of buffering',
		status: buildStatusMeta('failed'),
		at: ago(14),
		branch: 'feat/stream',
		duration: '1m 12s',
		href: '#'
	},
	{
		id: 'f4',
		app: 'terra-client',
		message: 'Add sponsors section',
		status: buildStatusMeta('succeeded'),
		at: ago(60 * 5),
		branch: 'main',
		duration: '58s',
		image: 'https://assets.orchard.my/project-backgrounds/82672415-a9cd-437f-b2f8-f4571e5306fa.png',
		href: '#'
	},
	{
		id: 'f5',
		app: 'docs',
		message: 'Document the new CLI flags',
		status: buildStatusMeta('canceled'),
		at: ago(60 * 7),
		branch: 'main',
		href: '#'
	}
];
