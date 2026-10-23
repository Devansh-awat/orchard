<script lang="ts">
	import {
		ArrowUpDown,
		Box,
		Container,
		Copy,
		Database,
		Ellipsis,
		ExternalLink,
		GitBranch,
		Github,
		LayoutTemplate,
		Pencil,
		Plus,
		RotateCw,
		ScrollText,
		Square,
		Trash2
	} from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import MenuLabel from '$lib/components/ui/MenuLabel.svelte';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';

	const SORTS = [
		{ value: 'deployed', label: 'Last deployed' },
		{ value: 'name', label: 'Name' },
		{ value: 'status', label: 'Status' }
	];

	let sort = $state('deployed');
	let showStopped = $state(true);
	let showPreviews = $state(false);
	let last = $state('Nothing picked yet');

	const sortLabel = $derived(SORTS.find((s) => s.value === sort)?.label ?? '');
</script>

<SectionCard
	title="Live menus"
	description="Actions on a thing. Glass panel, 32px rows, arrow keys and type to jump."
>
	<div class="flex flex-wrap items-center gap-3">
		<Menu placement="bottom-start">
			{#snippet trigger(props)}<Button {...props} icon={Ellipsis} label="App actions" />{/snippet}
			<MenuItem icon={RotateCw} shortcut="⌘R" onclick={() => (last = 'Redeploy')}>Redeploy</MenuItem
			>
			<MenuItem icon={ExternalLink} href="#menus">Open URL</MenuItem>
			<MenuItem icon={Copy} shortcut="⌘C" onclick={() => (last = 'Copy URL')}>Copy URL</MenuItem>
			<MenuSeparator />
			<MenuItem icon={ScrollText} shortcut="⌘L" onclick={() => (last = 'View logs')}
				>View logs</MenuItem
			>
			<MenuItem icon={Pencil} onclick={() => (last = 'Rename')}>Rename</MenuItem>
			<MenuItem icon={Square} disabled>Stop</MenuItem>
			<MenuSeparator />
			<MenuItem icon={Trash2} danger shortcut="⌘⌫" onclick={() => (last = 'Delete')}
				>Delete app</MenuItem
			>
		</Menu>

		<Menu placement="bottom-start">
			{#snippet trigger(props)}<Button {...props} icon={ArrowUpDown}>{sortLabel}</Button>{/snippet}
			<MenuLabel>Sort by</MenuLabel>
			{#each SORTS as s (s.value)}
				<MenuItem checked={sort === s.value} onclick={() => (sort = s.value)}>{s.label}</MenuItem>
			{/each}
			<MenuSeparator />
			<MenuLabel>Show</MenuLabel>
			<MenuItem checked={showStopped} onclick={() => (showStopped = !showStopped)}
				>Stopped apps</MenuItem
			>
			<MenuItem checked={showPreviews} onclick={() => (showPreviews = !showPreviews)}
				>Preview deployments</MenuItem
			>
		</Menu>

		<Menu placement="bottom-start">
			{#snippet trigger(props)}<Button {...props} variant="primary" icon={Plus}>New</Button
				>{/snippet}
			<MenuLabel>Deploy</MenuLabel>
			<MenuItem icon={Github} onclick={() => (last = 'GitHub repo')}>GitHub repo</MenuItem>
			<MenuItem icon={Container} onclick={() => (last = 'Docker image')}>Docker image</MenuItem>
			<MenuItem icon={LayoutTemplate} onclick={() => (last = 'Template')}>From a template</MenuItem>
			<MenuSeparator />
			<MenuLabel>Add</MenuLabel>
			<MenuItem icon={Database} onclick={() => (last = 'Database')}>Database</MenuItem>
			<MenuItem icon={Box} onclick={() => (last = 'Volume')}>Volume</MenuItem>
		</Menu>

		<Menu placement="bottom-start">
			{#snippet trigger(props)}<Button {...props} variant="ghost">Plain children</Button>{/snippet}
			<MenuItem onclick={() => (last = 'Redeploy')}><RotateCw size={14} /> Redeploy</MenuItem>
			<MenuItem onclick={() => (last = 'Copy URL')}><Copy size={14} /> Copy URL</MenuItem>
			<MenuItem danger onclick={() => (last = 'Delete')}><Trash2 size={14} /> Delete app</MenuItem>
		</Menu>

		<span class="ml-auto text-callout text-muted"
			>Last action: <span class="text-fg">{last}</span></span
		>
	</div>
</SectionCard>

<div class="grid grid-cols-3 gap-6">
	<div class="stage">
		<p class="text-caption font-medium text-faint">Rest, highlighted, disabled, danger</p>
		<div class="ui-menu specimen" role="menu" data-open>
			<MenuItem icon={RotateCw} shortcut="⌘R">Redeploy</MenuItem>
			<MenuItem icon={Copy} shortcut="⌘C" data-highlighted>Copy URL</MenuItem>
			<MenuItem icon={GitBranch}>Switch branch</MenuItem>
			<MenuSeparator />
			<MenuItem icon={Square} disabled>Stop</MenuItem>
			<MenuSeparator />
			<MenuItem icon={Trash2} danger shortcut="⌘⌫">Delete app</MenuItem>
		</div>
	</div>
	<div class="stage">
		<p class="text-caption font-medium text-faint">Sections and checkmarks</p>
		<div class="ui-menu specimen" role="menu" data-open>
			<MenuLabel>Sort by</MenuLabel>
			<MenuItem checked>Last deployed</MenuItem>
			<MenuItem checked={false} data-highlighted>Name</MenuItem>
			<MenuItem checked={false}>Status</MenuItem>
			<MenuSeparator />
			<MenuLabel>Show</MenuLabel>
			<MenuItem checked>Stopped apps</MenuItem>
			<MenuItem checked={false}>Preview deployments</MenuItem>
		</div>
	</div>
	<div class="stage">
		<p class="text-caption font-medium text-faint">Danger highlighted, long label</p>
		<div class="ui-menu specimen" role="menu" data-open>
			<MenuItem icon={ExternalLink}>Open hackclub-site.orchard.my in a new tab</MenuItem>
			<MenuItem icon={ScrollText} shortcut="⌘L">View logs</MenuItem>
			<MenuSeparator />
			<MenuItem icon={Trash2} danger data-highlighted>Delete environment</MenuItem>
		</div>
	</div>
</div>

<style>
	.stage {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 1.5rem;
		border-radius: var(--radius-card);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 1px var(--border-default);
	}
	.specimen {
		width: 15rem;
		max-height: none;
	}
</style>
