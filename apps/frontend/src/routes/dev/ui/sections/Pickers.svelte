<script lang="ts">
	import { Container, Cpu, GitBranch, Github, Globe, Server } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Dropdown from '$lib/components/ui/Dropdown.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import SwatchPicker from '$lib/components/ui/SwatchPicker.svelte';
	import SearchPicker from '$lib/components/ui/SearchPicker.svelte';
	import SelectTrigger from '$lib/components/ui/SelectTrigger.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import MenuLabel from '$lib/components/ui/MenuLabel.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import type { DropdownOption } from '$lib/components/ui/dropdown';
	import AmountSlider from '$lib/components/ui/AmountSlider.svelte';
	import GitHostMark, { type GitHost } from '$lib/components/ui/GitHostMark.svelte';
	const HOSTS: GitHost[] = ['github', 'gitlab', 'codeberg', 'gitea', 'bitbucket', 'generic'];
	import { formatMemory, parseMemory } from '$lib/components/ResourcePicker.svelte';

	const MB = 1024 ** 2;
	const MEMORY = [
		128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768
	].map((m) => m * MB);
	let memOpen = $state<number | null>(null);
	let memTight = $state<number | null>(null);
	let memOver = $state<number | null>(3072 * MB);
	let memWide = $state<number | null>(2048 * MB);
	let memNone = $state<number | null>(null);

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
	let range = $state('7d');
	let timeZone = $state('Europe/Berlin');
	const TIME_ZONES = Intl.supportedValuesOf('timeZone');
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
	let remoteRepo = $state('');
	let remoteQuery = $state('');
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
		<Field label="Log range, small" for="pk-range">
			<Dropdown
				id="pk-range"
				size="sm"
				bind:value={range}
				options={[
					{ value: '1h', label: 'Last hour' },
					{ value: '24h', label: 'Last 24 hours' },
					{ value: '7d', label: 'Last 7 days' }
				]}
			/>
		</Field>
	</div>
</SectionCard>

<div class="grid grid-cols-2 gap-6">
	<SectionCard title="SwatchPicker">
		<SwatchPicker
			label="Accent"
			options={[
				{ value: 'red', label: 'Red', fill: 'var(--hue-red, var(--status-error))' },
				{ value: 'green', label: 'Green', fill: 'var(--status-success)' },
				{ value: 'amber', label: 'Amber', fill: 'var(--status-warning)' },
				{ value: 'blue', label: 'Blue', fill: 'var(--status-info)' }
			]}
		/>
	</SectionCard>
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

	<SectionCard
		title="Select"
		description="Native OS menu. Only for very long plain lists where nobody needs to search."
	>
		<div class="flex flex-col gap-4">
			<Field label="Time zone" for="pk-tz" hint="{TIME_ZONES.length} zones in the OS list.">
				<Select id="pk-tz" bind:value={timeZone}>
					{#each TIME_ZONES as tz (tz)}<option value={tz}>{tz}</option>{/each}
				</Select>
			</Field>
		</div>
	</SectionCard>
</div>

<SectionCard
	title="Pickers that look alike"
	description="Choosing a project, an environment, an account or a repo is one kind of control: a SelectTrigger that opens the shared floating list. Long lists add a search field at the top of the same panel with SearchPicker; lists searched on the server pass searching while a query is in flight."
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
		<SearchPicker
			options={PICK_REPOS}
			bind:value={remoteRepo}
			bind:query={remoteQuery}
			searching={!!remoteQuery.trim()}
			placeholder="Searched on the server"
			searchPlaceholder="Type to search"
			width="22rem"
		>
			{#snippet optionLeading()}<Github size={15} />{/snippet}
		</SearchPicker>
	</div>
</SectionCard>

<SectionCard
	title="Amount slider"
	description="The scale fits what you can still use: it ends at your limit, or keeps doubling past 32 GB when you have more."
>
	<div class="amounts">
		<AmountSlider
			label="No limit, with a suggestion"
			bind:value={memOpen}
			stops={MEMORY}
			format={formatMemory}
			parse={parseMemory}
			fallback={512 * MB}
			usage={300 * MB}
			recommended={384 * MB}
		/>
		<AmountSlider
			label="2 GB left"
			bind:value={memTight}
			stops={MEMORY}
			format={formatMemory}
			parse={parseMemory}
			fallback={512 * MB}
			limit={2048 * MB}
		/>
		<AmountSlider
			label="Default bigger than what is left"
			bind:value={memNone}
			stops={MEMORY}
			format={formatMemory}
			parse={parseMemory}
			fallback={1024 * MB}
			limit={768 * MB}
		/>
		<AmountSlider
			label="Already over"
			bind:value={memOver}
			stops={MEMORY}
			format={formatMemory}
			parse={parseMemory}
			fallback={512 * MB}
			limit={1536 * MB}
		/>
		<AmountSlider
			label="Lots of room, with usage"
			bind:value={memWide}
			stops={MEMORY}
			format={formatMemory}
			parse={parseMemory}
			fallback={512 * MB}
			limit={96 * 1024 * MB}
			usage={1300 * MB}
		/>
		<AmountSlider
			label="Nothing left"
			value={null}
			stops={MEMORY}
			format={formatMemory}
			parse={parseMemory}
			fallback={512 * MB}
			limit={0}
		/>
	</div>
</SectionCard>

<SectionCard
	title="Git hosts"
	description="GitHostMark. Brand colours come from the --mark-* tokens."
>
	<div class="hosts">
		{#each HOSTS as host (host)}
			<div class="host">
				<GitHostMark {host} />
				<GitHostMark {host} size={32} />
				<span>{host}</span>
			</div>
		{/each}
	</div>
</SectionCard>

<style>
	.hosts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-6);
	}
	.host {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-callout);
		color: var(--text-muted);
	}
	.amounts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-6) var(--space-8);
	}
</style>
