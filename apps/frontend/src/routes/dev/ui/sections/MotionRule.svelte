<script lang="ts">
	import { Plus, Search, X } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Swap from '$lib/components/ui/Swap.svelte';
	import Disclosure from '$lib/components/ui/Disclosure.svelte';
	import Dropdown from '$lib/components/ui/Dropdown.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import UnderlineTabs from '$lib/components/ui/UnderlineTabs.svelte';

	const NAMES = [
		'DATABASE_URL',
		'REDIS_URL',
		'SESSION_SECRET',
		'SENTRY_DSN',
		'PUBLIC_API_BASE',
		'SMTP_HOST',
		'LOG_LEVEL'
	];

	let next = 3;
	let vars = $state(NAMES.slice(0, 3).map((name, id) => ({ id, name })));

	function addVar() {
		vars = [...vars, { id: next, name: NAMES[next % NAMES.length] }];
		next += 1;
	}

	function removeVar(id: number) {
		vars = vars.filter((v) => v.id !== id);
	}

	let source = $state('git');
	let tab = $state('overview');
	let region = $state('ams');
	let advanced = $state(false);
	let port = $state('');
	let checked = $state(false);
	const portError = $derived(
		checked && !/^\d+$/.test(port.trim()) ? 'Port must be a number, like 3000' : null
	);

	let query = $state('');
	const filtered = $derived(
		NAMES.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase()))
	);
</script>

<SectionCard
	title="What moves, what doesn't"
	description="Motion when you caused a spatial change. Instant when reality did, while you type, and for anything you repeat."
>
	<div class="rule-grid">
		<div class="stage">
			<div class="stage-head">
				<span class="stage-title">Rows you add and delete</span>
				<Button size="sm" variant="ghost" icon={Plus} onclick={addVar}>Add</Button>
			</div>
			<List label="Variables">
				{#each vars as v (v.id)}
					<ListRow title={v.name} presence>
						{#snippet actions()}
							<Button
								size="sm"
								variant="ghost"
								icon={X}
								label="Remove {v.name}"
								onclick={() => removeVar(v.id)}
							/>
						{/snippet}
					</ListRow>
				{/each}
			</List>
			<p class="stage-note">The space opens on glide and closes on settle. Nothing jumps shut.</p>
		</div>

		<div class="stage">
			<div class="stage-head">
				<span class="stage-title">Swaps</span>
				<SegmentedControl
					size="sm"
					label="Source"
					bind:value={source}
					options={[
						{ value: 'git', label: 'Git' },
						{ value: 'image', label: 'Image' },
						{ value: 'template', label: 'Template' }
					]}
				/>
			</div>
			<div class="swap-card">
				<Swap key={source}>
					{#if source === 'git'}
						<div class="swap-body">
							<Field label="Repository"><Input value="hackclub/site" mono /></Field>
							<Field label="Branch"><Input value="main" mono /></Field>
						</div>
					{:else if source === 'image'}
						<div class="swap-body">
							<Field label="Image"><Input value="ghcr.io/hackclub/site:latest" mono /></Field>
						</div>
					{:else}
						<div class="swap-body">
							<Field label="Template"><Input value="Next.js" /></Field>
							<Field label="Name"><Input value="my-site" /></Field>
							<Field label="Region"><Input value="Amsterdam" /></Field>
						</div>
					{/if}
				</Swap>
			</div>
			<UnderlineTabs
				bind:value={tab}
				tabs={[
					{ id: 'overview', label: 'Overview' },
					{ id: 'environment', label: 'Environment' },
					{ id: 'network', label: 'Network' }
				]}
			/>
			<p class="stage-note">
				Old content leaves at once, new content rises in, the box morphs height.
			</p>
		</div>

		<div class="stage">
			<div class="stage-head">
				<span class="stage-title">Opens, closes, errors</span>
				<div class="w-40">
					<Dropdown
						bind:value={region}
						size="sm"
						ariaLabel="Region"
						options={[
							{ value: 'ams', label: 'Amsterdam' },
							{ value: 'iad', label: 'Virginia' },
							{ value: 'sin', label: 'Singapore' }
						]}
					/>
				</div>
			</div>
			<Disclosure title="Advanced" note="Port 3000" bind:open={advanced}>
				<Field label="Port" error={portError} for="rule-port">
					<Input id="rule-port" bind:value={port} placeholder="3000" mono width="short" />
				</Field>
				<div>
					<Button size="sm" onclick={() => (checked = !checked)}
						>{checked ? 'Clear check' : 'Check port'}</Button
					>
				</div>
			</Disclosure>
			<p class="stage-note">
				Menus spring in from the side they open on. The error text is instant; its line opens.
			</p>
		</div>

		<div class="stage">
			<div class="stage-head">
				<span class="stage-title">Instant on purpose</span>
			</div>
			<Input bind:value={query} icon={Search} size="sm" placeholder="Filter variables" />
			<ul class="instant-list">
				{#each filtered as name (name)}
					<li class="instant-row">{name}</li>
				{:else}
					<li class="instant-row instant-row--empty">Nothing matches</li>
				{/each}
			</ul>
			<p class="stage-note">
				Typing filters without a stagger. A spring per keystroke is latency, not feedback.
			</p>
		</div>
	</div>
</SectionCard>

<style>
	.rule-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1.5rem;
	}
	.stage {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.stage-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 2rem;
	}
	.stage-title {
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.stage-note {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.swap-card {
		padding: 1rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.swap-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.instant-list {
		display: flex;
		flex-direction: column;
		min-height: 9rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.instant-row {
		padding: 0.375rem 0.5rem;
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		color: var(--text-default);
	}
	.instant-row--empty {
		font-family: inherit;
		color: var(--text-faint);
	}
</style>
