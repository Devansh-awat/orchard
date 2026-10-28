<script lang="ts">
	import { Container, Github } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import FeatureHero from '$lib/components/patterns/FeatureHero.svelte';
	import Dock, { type DockItem } from '$lib/components/patterns/Dock.svelte';
	import Shelf from '$lib/components/patterns/Shelf.svelte';
	import ProductHeader from '$lib/components/patterns/ProductHeader.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Disclosure from '$lib/components/ui/Disclosure.svelte';
	import Stack from '$lib/components/ui/Stack.svelte';
	import FormActions from '$lib/components/ui/FormActions.svelte';
	import ParamField, { type ParamDef } from '$lib/components/patterns/ParamField.svelte';
	import ResourceList from '$lib/components/patterns/ResourceList.svelte';
	import { IMG_ICONS } from '$lib/components/org-dashboard/helpers.svelte';
	import { TEMPLATE_SHELVES } from '../home-fixtures';
	import RowList from '$lib/components/ui/RowList.svelte';
	import DisclosureGroup from '$lib/components/ui/DisclosureGroup.svelte';
	import FieldGrid from '$lib/components/ui/FieldGrid.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import Dropdown from '$lib/components/ui/Dropdown.svelte';

	let demoSeq = 2;
	let demoVolumes = $state([
		{ id: 1, name: 'uploads', path: '/app/uploads', readOnly: false },
		{ id: 2, name: 'config', path: '/etc/app', readOnly: true }
	]);
	let demoStage = $state('');

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

	const PARAMS: ParamDef[] = [
		{
			name: 'appName',
			displayName: 'App name',
			type: 'string',
			required: true,
			description: 'Used for its internal hostname.'
		},
		{
			name: 'serverType',
			displayName: 'Server type',
			type: 'select',
			options: [
				{ label: 'Paper', value: 'paper' },
				{ label: 'Vanilla', value: 'vanilla' },
				{ label: 'Fabric', value: 'fabric' }
			]
		},
		{
			name: 'timezone',
			displayName: 'Timezone',
			type: 'select',
			options: ['New York', 'London', 'Berlin', 'Tokyo', 'UTC'].map((l) => ({ label: l, value: l }))
		},
		{ name: 'storageGi', displayName: 'Storage', type: 'number', validation: { min: 1, max: 200 } },
		{
			name: 'members',
			displayName: 'Enable memberships',
			type: 'boolean',
			description: 'Let readers sign up.'
		},
		{ name: 'secret', displayName: 'Encryption key', type: 'secret' }
	];
	let values = $state<Record<string, any>>({
		appName: 'ghost',
		serverType: 'paper',
		timezone: 'UTC',
		storageGi: 10,
		members: true,
		secret: ''
	});
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

<SectionCard
	title="Product header"
	description="The top of a template or product page: a big icon tile, what it is, and the one decision to make before going on."
>
	<ProductHeader
		title={TEMPLATE_SHELVES[0].items[1].title}
		eyebrow={TEMPLATE_SHELVES[0].items[1].subtitle}
		description={TEMPLATE_SHELVES[0].items[1].description}
		icon={TEMPLATE_SHELVES[0].items[1].icon}
	>
		{#snippet meta()}<Badge>v1.0.0</Badge><Badge>cms</Badge>{/snippet}
		{#snippet actions()}<Button variant="primary">Deploy</Button>{/snippet}
	</ProductHeader>
</SectionCard>

<SectionCard
	title="Disclosure"
	description="Optional settings that most people skip. Closed by default; the note says what happens if you leave it."
>
	<Disclosure title="Set limits" note="Org defaults if you skip this">
		<p class="text-callout text-muted">CPU and memory pickers go here.</p>
	</Disclosure>
</SectionCard>

<SectionCard
	title="Template parameters"
	description="ParamField picks the control from the parameter type: text, a segmented choice up to four options and a dropdown beyond, a short number with its unit, a toggle, or a secret that reveals on demand."
>
	<Stack gap="lg">
		{#each PARAMS as param (param.name)}
			<ParamField {param} bind:value={values[param.name]} />
		{/each}
		<FormActions
			><Button variant="ghost">Cancel</Button><Button variant="primary">Deploy</Button></FormActions
		>
	</Stack>
</SectionCard>

<SectionCard
	title="Resource list"
	description="What a template or stack creates, in the app's own icon language."
>
	<ResourceList
		items={[
			{ name: 'ghost', type: 'deployment' },
			{ name: 'ghost-db', type: 'database' },
			{ name: 'ghost-web', type: 'ingress' }
		]}
	/>
</SectionCard>

<SectionCard
	title="Rows, folds and field grids"
	description="RowList for rows people add and remove, DisclosureGroup for folded settings, FieldGrid for two fields side by side."
>
	<Stack gap="lg">
		<RowList
			label="Volumes"
			items={demoVolumes}
			key={(v) => v.id}
			columns={[{ label: 'Name' }, { label: 'Mount path' }, { label: 'Read-only', width: '4rem' }]}
			addLabel="Add volume"
			onadd={() =>
				(demoVolumes = [...demoVolumes, { id: ++demoSeq, name: '', path: '', readOnly: false }])}
			onremove={(i) => (demoVolumes = demoVolumes.filter((_, n) => n !== i))}
			removeLabel={(v) => `Remove ${v.name || 'volume'}`}
		>
			{#snippet row(volume)}
				<Input bind:value={volume.name} placeholder="data" aria-label="Volume name" />
				<Input bind:value={volume.path} placeholder="/data" aria-label="Mount path" mono />
				<Switch bind:checked={volume.readOnly} label="Read-only" />
			{/snippet}
		</RowList>
		<FieldGrid ratio="golden">
			<Field label="Dockerfile"><Input size="lg" value="Dockerfile" mono /></Field>
			<Field label="Stage">
				<Dropdown
					size="lg"
					bind:value={demoStage}
					options={[
						{ value: '', label: 'Final stage' },
						{ value: 'build', label: 'build', mono: true }
					]}
				/>
			</Field>
		</FieldGrid>
		<DisclosureGroup>
			<Disclosure title="Storage" note="2 volumes"
				><p class="text-callout text-muted">Rows go here.</p></Disclosure
			>
			<Disclosure title="Resources" note="Org default"
				><p class="text-callout text-muted">The resource picker goes here.</p></Disclosure
			>
			<Disclosure title="Scaling" note="1 replica"
				><p class="text-callout text-muted">Replicas go here.</p></Disclosure
			>
		</DisclosureGroup>
	</Stack>
</SectionCard>
