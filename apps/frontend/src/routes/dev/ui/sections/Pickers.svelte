<script lang="ts">
	import { Container, Cpu, GitBranch, Github, Globe, Server } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Dropdown from '$lib/components/ui/Dropdown.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import SearchPicker from '$lib/components/ui/SearchPicker.svelte';
	import SelectTrigger from '$lib/components/ui/SelectTrigger.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import MenuLabel from '$lib/components/ui/MenuLabel.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import type { DropdownOption } from '$lib/components/ui/dropdown';

	const REGIONS: DropdownOption[] = [
		{ value: 'fsn1', label: 'Falkenstein', description: 'fsn1 · Germany', icon: Globe },
		{ value: 'hel1', label: 'Helsinki', description: 'hel1 · Finland', icon: Globe },
		{ value: 'ash', label: 'Ashburn', description: 'ash · Virginia, US', icon: Globe },
		{
			value: 'hil',
			label: 'Hillsboro',
			description: 'hil · Oregon, US · coming soon',
			icon: Globe,
			disabled: true
		}
	];

	const SIZES: DropdownOption[] = [
		{ value: 'nano', label: 'Nano', description: '0.25 vCPU · 256 MB', icon: Cpu },
		{ value: 'small', label: 'Small', description: '0.5 vCPU · 512 MB', icon: Cpu },
		{ value: 'medium', label: 'Medium', description: '1 vCPU · 1 GB', icon: Server },
		{ value: 'large', label: 'Large', description: '2 vCPU · 4 GB', icon: Server }
	];

	const POLICIES: DropdownOption[] = [
		{ value: 'forbid', label: 'Skip the new run' },
		{ value: 'allow', label: 'Run them in parallel' },
		{ value: 'replace', label: 'Replace the running one' }
	];

	const IMAGES: DropdownOption[] = [
		{ value: 'node:22-alpine', label: 'node:22-alpine', mono: true, icon: Container },
		{ value: 'python:3.13-slim', label: 'python:3.13-slim', mono: true, icon: Container },
		{ value: 'oven/bun:1.2', label: 'oven/bun:1.2', mono: true, icon: Container }
	];

	const REPOS: DropdownOption[] = [
		{
			value: 'hackclub/site',
			label: 'hackclub/site',
			description: 'Pushed 3 hours ago',
			icon: Github
		},
		{
			value: 'hackclub/arcade-leaderboard',
			label: 'hackclub/arcade-leaderboard',
			description: 'Pushed yesterday',
			icon: Github
		},
		{
			value: 'hackclub/orchard',
			label: 'hackclub/orchard',
			description: 'Pushed 12 minutes ago',
			icon: Github
		},
		{
			value: 'hackclub/sprig',
			label: 'hackclub/sprig',
			description: 'Pushed last week',
			icon: Github
		},
		{
			value: 'hackclub/hcb',
			label: 'hackclub/hcb',
			description: 'Pushed 2 days ago',
			icon: Github
		},
		{
			value: 'hackclub/summer',
			label: 'hackclub/summer',
			description: 'Pushed in June',
			icon: Github
		}
	];

	const BRANCHES: DropdownOption[] = [
		'main',
		'feat/sponsors',
		'feat/dark-mode',
		'fix/og-images',
		'chore/bump-deps',
		'release/2026-10'
	].map((b) => ({ value: b, label: b, mono: true, icon: GitBranch }));

	let region = $state('fsn1');
	let size = $state('small');
	let policy = $state('forbid');
	let image = $state('');
	let nativeRegion = $state('hel1');
	let nativeSmall = $state('7d');
	let repo = $state('hackclub/site');
	let branch = $state('');
	let custom = $state('');
	let customQuery = $state('');
	let customBranches = $state<DropdownOption[]>(BRANCHES);

	const PICK_REPOS: DropdownOption[] = [
		'orpheus/hackclub-site',
		'orpheus/terra',
		'orpheus/flavortown',
		'hackclub/mercury',
		'hackclub/slack-bots',
		'hackclub/arcade-leaderboard'
	].map((r, i) => ({ value: r, label: r, description: i % 3 === 0 ? 'Private' : undefined }));
	let pickRepo = $state('orpheus/terra');
	let pickEnv = $state('production');
</script>

{#snippet defaultBadge(option: DropdownOption)}
	{#if option.value === 'main'}<Badge tone="neutral">Default</Badge>{/if}
{/snippet}

<SectionCard
	title="Dropdown"
	description="Rich value picker. Arrow keys move, Enter picks, letters jump."
>
	<div class="grid grid-cols-3 gap-4">
		<Field label="Region">
			<Dropdown bind:value={region} options={REGIONS} />
		</Field>
		<Field label="Instance size">
			<Dropdown bind:value={size} options={SIZES} />
		</Field>
		<Field label="When a run is still going">
			<Dropdown bind:value={policy} options={POLICIES} />
		</Field>
		<Field label="Base image" hint="Nothing picked yet shows the placeholder.">
			<Dropdown bind:value={image} options={IMAGES} placeholder="Pick an image" />
		</Field>
		<Field label="Disabled">
			<Dropdown value="fsn1" options={REGIONS} disabled />
		</Field>
	</div>
</SectionCard>

<div class="grid grid-cols-2 gap-6">
	<SectionCard title="Combobox" description="Searchable. Type to filter, Escape clears.">
		<div class="flex flex-col gap-4">
			<Field label="Repository">
				<Combobox
					bind:value={repo}
					options={REPOS}
					label="Repository"
					placeholder="Search repositories"
				/>
			</Field>
			<Field label="Branch" hint="Try typing “zzz” to see the empty row.">
				<Combobox
					bind:value={branch}
					options={BRANCHES}
					label="Branch"
					placeholder="Search branches"
				/>
			</Field>
			<Field label="Creatable" hint="Type a branch that is not listed to use it anyway.">
				<Combobox
					bind:value={custom}
					bind:query={customQuery}
					options={customBranches}
					label="Creatable"
					icon={GitBranch}
					placeholder="main"
					creatable
					createLabel={(q) => `Use ${q}`}
					oncreate={(q) => {
						customBranches = [
							{ value: q, label: q, mono: true, icon: GitBranch },
							...customBranches
						];
						custom = q;
					}}
					onclear={() => {
						custom = '';
						customQuery = '';
					}}
					trailing={defaultBadge}
				/>
			</Field>
			<Field label="Loading">
				<Combobox value="" options={[]} label="Loading" loading empty="Loading branches" />
			</Field>
			<Field label="Disabled">
				<Combobox value="main" options={BRANCHES} label="Disabled" disabled />
			</Field>
		</div>
	</SectionCard>

	<SectionCard title="Select" description="Native. Use it for short, plain lists.">
		<div class="flex flex-col gap-4">
			<Field label="Region" for="pk-region">
				<Select id="pk-region" bind:value={nativeRegion}>
					<option value="fsn1">Falkenstein</option>
					<option value="hel1">Helsinki</option>
					<option value="ash">Ashburn</option>
				</Select>
			</Field>
			<Field label="Log range, small" for="pk-range">
				<Select id="pk-range" size="sm" bind:value={nativeSmall}>
					<option value="1h">Last hour</option>
					<option value="24h">Last 24 hours</option>
					<option value="7d">Last 7 days</option>
				</Select>
			</Field>
			<Field label="Disabled" for="pk-disabled">
				<Select id="pk-disabled" disabled value="fsn1">
					<option value="fsn1">Falkenstein</option>
				</Select>
			</Field>
		</div>
	</SectionCard>
</div>

<SectionCard
	title="Pickers that look alike"
	description="Choosing a project, an environment, an account or a repo is one kind of control: a SelectTrigger that opens the shared floating list. Long lists add a search field at the top of the same panel with SearchPicker."
>
	<div class="flex flex-wrap items-center gap-3">
		<Menu placement="bottom-start" size="lg">
			{#snippet trigger(attrs, open)}
				<SelectTrigger {...attrs} {open} prefix="Environment" value={pickEnv} />
			{/snippet}
			<MenuLabel>Environment</MenuLabel>
			{#each ['production', 'staging', 'preview'] as e (e)}
				<MenuItem checked={pickEnv === e} onclick={() => (pickEnv = e)}>{e}</MenuItem>
			{/each}
		</Menu>
		<SearchPicker
			options={PICK_REPOS}
			bind:value={pickRepo}
			prefix="Repository"
			searchPlaceholder="Search repositories"
			creatable
			width="22rem"
		>
			{#snippet optionLeading()}<Github size={15} />{/snippet}
		</SearchPicker>
	</div>
</SectionCard>
