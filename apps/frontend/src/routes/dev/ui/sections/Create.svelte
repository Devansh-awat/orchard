<script lang="ts">
	import { Container, Github } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import FeatureHero from '$lib/components/patterns/FeatureHero.svelte';
	import Dock, { type DockItem } from '$lib/components/patterns/Dock.svelte';
	import Shelf from '$lib/components/patterns/Shelf.svelte';
	import { IMG_ICONS } from '$lib/components/org-dashboard/helpers.svelte';
	import { TEMPLATE_SHELVES } from '../home-fixtures';

	const featured = TEMPLATE_SHELVES[0].items.slice(0, 4).map((t) => ({
		id: t.id,
		title: t.title,
		eyebrow: t.subtitle,
		description: t.description,
		icon: t.icon,
		href: '#'
	}));

	const dock: DockItem[] = [
		{
			id: 'github',
			label: 'GitHub repo',
			hint: 'Deploy straight from your code',
			icon: Github,
			tone: 'ink',
			badge: 'Fastest'
		},
		{
			id: 'image',
			label: 'Docker image',
			hint: 'Run a published container',
			icon: Container,
			tone: 'blue'
		},
		{
			id: 'postgres',
			label: 'PostgreSQL',
			hint: 'Managed, with backups',
			image: IMG_ICONS.postgres
		},
		{ id: 'redis', label: 'Redis', hint: 'Valkey cache', image: IMG_ICONS.redis }
	];

	let busy = $state<string | null>(null);
</script>

<SectionCard
	title="Feature hero"
	description="One rotating banner for the thing worth starting with. The backdrop is the item's own icon, blurred; it pauses on hover and focus, and arrow keys move it."
>
	<FeatureHero items={featured} />
</SectionCard>

<SectionCard
	title="Dock"
	description="The few ways to start from nothing, as big tiles in one tray. Tones are solid fills from the scales; paper tiles carry a real logo. busy shows a spinner on the chosen tile and quiets the rest."
>
	<Dock
		label="Start from scratch"
		items={dock}
		{busy}
		onSelect={(item) => {
			busy = item.id;
			setTimeout(() => (busy = null), 1500);
		}}
	/>
</SectionCard>

<SectionCard
	title="Shelf"
	description="A horizontal row of 16:9 tiles with a tinted backdrop baked from each icon. onSelect lets a tile run work before navigating; cmd-click still opens the link."
>
	<Shelf title={TEMPLATE_SHELVES[1].title} items={TEMPLATE_SHELVES[1].items} />
</SectionCard>
