import { BookOpen, Box, Copy, Database, Moon, Plus, Timer, UserPlus } from 'lucide-svelte';
import type { PaletteAction, PaletteItem } from '$lib/components/patterns/command-palette';
import { themeStore } from '$lib/stores/theme';
import { PROJECTS, MORE_PROJECTS } from './fixtures';

const ALL = [...PROJECTS, ...MORE_PROJECTS];

export const PALETTE_ITEMS: PaletteItem[] = ALL.flatMap((p) => [
	{
		id: p.id,
		label: p.name,
		sublabel: p.counts.join(' · '),
		kind: 'project' as const,
		icon: p.image,
		href: `#${p.id}`
	},
	...p.entities.map((e) => {
		const url = 'url' in e && typeof e.url === 'string' ? `https://${e.url}` : undefined;
		return {
			id: `${p.id}-${e.name}`,
			label: e.name,
			sublabel: p.name,
			project: p.name,
			projectIcon: p.image,
			kind: e.kind,
			status: e.status,
			href: `#${p.id}-${e.name}`,
			url
		};
	})
]);

export function paletteActions(say: (text: string) => () => void): PaletteAction[] {
	return [
		{
			id: 'new-deployment',
			label: 'New deployment',
			hint: 'From a repo or an image',
			icon: Box,
			keywords: ['create', 'deploy', 'app'],
			shortcut: '⌘⇧N',
			run: say('Started a new deployment')
		},
		{
			id: 'new-database',
			label: 'New database',
			hint: 'Postgres or Redis',
			icon: Database,
			keywords: ['create', 'postgres', 'redis', 'db'],
			shortcut: '⌘⇧D',
			run: say('Started a new database')
		},
		{
			id: 'new-job',
			label: 'New job',
			hint: 'Runs on a schedule',
			icon: Timer,
			keywords: ['cron', 'schedule', 'create'],
			run: say('Started a new job')
		},
		{
			id: 'new-project',
			label: 'New project',
			icon: Plus,
			keywords: ['create'],
			run: say('Started a new project')
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
		{
			id: 'copy-org',
			label: 'Copy org ID',
			hint: 'YSWS',
			icon: Copy,
			keywords: ['organization', 'id', 'clipboard'],
			run: () => {
				navigator.clipboard
					?.writeText('6e7235cf-d703-4868-9346-84de39f66e8c')
					.catch(() => undefined);
			}
		},
		{
			id: 'invite',
			label: 'Invite a teammate',
			icon: UserPlus,
			keywords: ['member', 'people', 'team'],
			run: say('Opened invites')
		},
		{
			id: 'docs',
			label: 'Open docs',
			icon: BookOpen,
			keywords: ['help', 'documentation', 'guide'],
			shortcut: '⌘/',
			run: say('Opened the docs')
		}
	];
}
