import { resourceStatus, buildStatusMeta } from '$lib/components/ui/status';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export const PROJECTS = [
	{
		id: 'p1',
		name: 'hackclub-site',
		entities: [
			{
				kind: 'deployment' as const,
				name: 'web',
				status: resourceStatus('running'),
				url: 'hackclub-site.orchard.my',
				detail: 'main · 4f2a9c1',
				updatedAt: ago(3)
			},
			{
				kind: 'deployment' as const,
				name: 'api',
				status: resourceStatus('running', 'building'),
				url: 'api.hackclub-site.orchard.my',
				detail: 'main · b81e0d4',
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
		name: 'arcade-leaderboard',
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
