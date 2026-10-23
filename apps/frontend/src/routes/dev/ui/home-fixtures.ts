import type { UpNextItem } from '$lib/components/patterns/UpNextShelf.svelte';
import type { AppDockItem } from '$lib/components/patterns/AppDock.svelte';
import type { SpotlightItem } from '$lib/components/patterns/HomeSpotlight.svelte';
import type { StatusMeta } from '$lib/components/ui/status';
import { PROJECTS, MORE_PROJECTS, BUILD_FEED } from './fixtures';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const [hackclub, terra] = PROJECTS;
const [flavortown, mercury] = MORE_PROJECTS;

export const UP_NEXT: UpNextItem[] = [
	{
		id: 'u1',
		app: 'api',
		project: hackclub.name,
		href: '#',
		icon: hackclub.image,
		status: 'Building',
		tone: 'progress',
		progress: 0.62,
		at: ago(0.5)
	},
	{
		id: 'u2',
		app: 'worker',
		project: terra.name,
		href: '#',
		icon: terra.image,
		background: terra.background,
		status: 'Crashed · out of memory',
		tone: 'error',
		at: ago(12)
	},
	{
		id: 'u3',
		app: 'web',
		project: flavortown.name,
		href: '#',
		icon: flavortown.image,
		status: 'Deployed',
		tone: 'success',
		at: ago(2)
	},
	{
		id: 'u4',
		app: 'terra-client',
		project: terra.name,
		href: '#',
		background: terra.background,
		status: 'Deploying',
		tone: 'progress',
		progress: 0.18,
		at: ago(1)
	},
	{
		id: 'u5',
		app: 'web',
		project: hackclub.name,
		href: '#',
		status: 'Deployed',
		tone: 'success',
		at: ago(3)
	},
	{
		id: 'u6',
		app: 'postgres',
		project: flavortown.name,
		href: '#',
		kind: 'database',
		status: 'Backed up',
		tone: 'success',
		at: ago(48)
	},
	{
		id: 'u7',
		app: 'web',
		project: mercury.name,
		href: '#',
		status: 'Deployed',
		tone: 'success',
		at: ago(26)
	},
	{
		id: 'u8',
		app: 'nightly-sync',
		project: terra.name,
		href: '#',
		kind: 'job',
		status: 'Next run at 03:00',
		tone: 'neutral'
	}
];

export const PINNED: AppDockItem[] = [
	{ id: 'd1', label: 'hackclub-site', href: '#', icon: hackclub.image },
	{ id: 'd2', label: 'api', href: '#', tone: 'progress', status: 'Building' },
	{ id: 'd3', label: 'terra', href: '#', icon: terra.image, tone: 'error', status: 'Crashing' },
	{ id: 'd4', label: 'flavortown', href: '#', icon: flavortown.image },
	{ id: 'd5', label: 'shipwright', href: '#' },
	{ id: 'd6', label: 'postgres', href: '#', kind: 'database' },
	{ id: 'd7', label: 'Mercury', href: '#' },
	{ id: 'd8', label: 'nightly-sync', href: '#', kind: 'job', tone: 'neutral' }
];

const [site] = PROJECTS;
const building = BUILD_FEED[0];

export const SPOTLIGHT: SpotlightItem[] = [
	{
		id: terra.id,
		name: terra.name,
		href: '#',
		url: 'https://worker-arcade-leaderboard.orchard.my',
		image: terra.image,
		background: terra.background,
		owner: terra.owner,
		status: 'worker is crashing · out of memory',
		tone: 'error',
		apps: terra.entities.map((e) => ({ name: e.name, kind: e.kind }))
	},
	{
		id: site.id,
		name: site.name,
		href: '#',
		url: 'https://hackclub-site.orchard.my',
		image: site.image,
		background: site.background,
		owner: site.owner,
		status: `${building.app} is building · ${building.branch} · ${building.message}`,
		tone: 'progress',
		apps: site.entities.map((e) => ({ name: e.name, kind: e.kind }))
	},
	{
		id: flavortown.id,
		name: flavortown.name,
		href: '#',
		url: 'https://flavortown.hackclub.com',
		image: flavortown.image,
		owner: flavortown.owner,
		status: `All ${flavortown.entities?.length ?? 0} apps running`,
		tone: 'success',
		apps: (flavortown.entities ?? []).map((e) => ({ name: e.name, kind: e.kind }))
	}
];

type Entity = {
	kind: 'deployment' | 'database' | 'job';
	name: string;
	status: StatusMeta;
	detail?: string;
	url?: string;
	updatedAt?: string | null;
};
type Source = {
	id: string;
	name: string;
	image?: string | null;
	background?: string | null;
	entities?: Entity[];
};

function summarize(apps: { status: StatusMeta }[]) {
	const failing = apps.filter((a) => a.status.kind === 'error').length;
	const building = apps.filter((a) => a.status.kind === 'progress').length;
	if (failing) return { tone: 'error' as const, label: `${failing} failing` };
	if (building) return { tone: 'progress' as const, label: `${building} building` };
	if (!apps.length) return { tone: 'neutral' as const, label: 'No apps yet' };
	return { tone: 'success' as const, label: 'All running' };
}

const sources: Source[] = [...PROJECTS, ...MORE_PROJECTS];

export const TILE_PROJECTS = sources.map((p) => {
	const apps = (p.entities ?? []).map((e) => ({
		name: e.name,
		kind: e.kind,
		status: e.status,
		detail: e.detail,
		url: e.url,
		updatedAt: e.updatedAt,
		href: '#'
	}));
	return {
		id: p.id,
		name: p.name,
		href: '#',
		image: p.image ?? null,
		background: p.background ?? null,
		summary: summarize(apps),
		apps
	};
});
