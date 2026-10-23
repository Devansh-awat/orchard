<script lang="ts">
	import {
		Plus,
		Rocket,
		Search,
		Settings,
		Trash2,
		ExternalLink,
		Ellipsis,
		Box
	} from 'lucide-svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import ToggleRow from '$lib/components/ui/ToggleRow.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Tabs from '$lib/components/ui/Tabs.svelte';
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import Metric from '$lib/components/ui/Metric.svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import MiddleTruncate from '$lib/components/ui/MiddleTruncate.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import { statusMeta, type StatusKind } from '$lib/components/ui/status';
	import { toasts } from '$lib/stores';
	import type { ToastInput, ToastPosition } from '$lib/stores/toast';
	import DevBar from './DevBar.svelte';
	import { PROJECTS } from './fixtures';

	const KINDS: StatusKind[] = ['success', 'progress', 'warning', 'error', 'info', 'neutral'];
	const LABELS: Record<StatusKind, string> = {
		success: 'Ready',
		progress: 'Building',
		warning: 'Unhealthy',
		error: 'Crashing',
		info: 'Queued',
		neutral: 'Stopped'
	};

	let seg = $state('day');
	let tab = $state<'overview' | 'logs' | 'metrics' | 'settings'>('overview');
	let on = $state(true);
	let autoDeploy = $state(false);
	let name = $state('hackclub-site');
	let region = $state('fsn1');
	let modalOpen = $state(false);
	let loading = $state(false);

	const POSITIONS: ToastPosition[] = [
		'top-left',
		'top-center',
		'top-right',
		'bottom-left',
		'bottom-center',
		'bottom-right'
	];
	let toastPos = $state<ToastPosition>('bottom-right');

	function fire(toast: Omit<ToastInput, 'position'>) {
		toasts.add({ ...toast, position: toastPos });
	}

	function fakeDeploy() {
		toasts.promise(new Promise((r) => setTimeout(r, 2200)), {
			loading: 'Deploying web',
			success: 'web is live',
			error: 'Deploy failed',
			description: 'hackclub-site.orchard.my now serves 4f2a9c1.',
			position: toastPos
		});
	}
</script>

<Page
	title="Orchard UI"
	description="Every primitive in every state. Flip the bar at the bottom to compare looks, schemes, palettes and fonts."
	width="wide"
>
	{#snippet eyebrow()}<a href="/dev/ui/compare">See the compare screens →</a>{/snippet}

	<SectionCard
		title="Buttons"
		description="One primary per view. Danger never takes the primary role."
	>
		<div class="flex flex-col gap-4">
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="primary" icon={Rocket}>Deploy</Button>
				<Button>Cancel</Button>
				<Button variant="ghost">Learn more</Button>
				<Button variant="danger" icon={Trash2}>Delete app</Button>
				<Button variant="primary" loading>Deploying</Button>
				<Button disabled>Disabled</Button>
				<Button icon={Settings} label="Settings" />
				<Button variant="ghost" icon={Ellipsis} label="More" />
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button size="sm" variant="primary" icon={Plus}>New</Button>
				<Button size="sm" iconRight={ExternalLink}>Visit</Button>
				<Button size="sm" variant="ghost">Ghost</Button>
				<Button size="sm" variant="danger">Remove</Button>
				<Button size="sm" icon={Settings} label="Settings" />
				<Button
					size="sm"
					variant="primary"
					{loading}
					onclick={() => {
						loading = true;
						setTimeout(() => (loading = false), 1500);
					}}>Save changes</Button
				>
			</div>
		</div>
	</SectionCard>

	<div class="grid grid-cols-2 gap-6">
		<SectionCard
			title="Status"
			description="Quiet when healthy. Live dot only while something is in flight."
		>
			<div class="flex flex-col gap-3">
				<div class="flex flex-wrap gap-2">
					{#each KINDS as k (k)}<StatusBadge
							meta={statusMeta(k, LABELS[k], k === 'progress')}
						/>{/each}
				</div>
				<div class="flex flex-wrap gap-2">
					{#each KINDS as k (k)}<StatusBadge
							variant="solid"
							meta={statusMeta(k, LABELS[k])}
						/>{/each}
				</div>
				<div class="flex flex-wrap gap-4">
					{#each KINDS as k (k)}<StatusBadge
							variant="plain"
							meta={statusMeta(k, LABELS[k], k === 'progress')}
						/>{/each}
				</div>
				<div class="flex flex-wrap gap-2">
					<Badge>Hobby</Badge>
					<Badge tone="accent">New</Badge>
					<Badge tone="success">+12%</Badge>
					<Badge tone="warning">Expiring</Badge>
					<Badge tone="error">3 errors</Badge>
					<Badge tone="info">Beta</Badge>
				</div>
			</div>
		</SectionCard>

		<SectionCard title="Feedback">
			<div class="flex flex-col gap-3">
				<Select size="sm" bind:value={toastPos} aria-label="Toast position">
					{#each POSITIONS as pos (pos)}<option value={pos}>{pos}</option>{/each}
				</Select>
				<div class="flex flex-wrap gap-2">
					<Button size="sm" onclick={() => fire({ title: 'Changes saved', color: 'success' })}
						>Success</Button
					>
					<Button
						size="sm"
						onclick={() =>
							fire({
								title: 'Build failed',
								description: 'worker exited with code 137 while installing dependencies.',
								color: 'error'
							})}>Error</Button
					>
					<Button
						size="sm"
						onclick={() =>
							fire({
								title: 'Memory is running low',
								description: 'api has used 92% of its 512 MB limit for 10 minutes.',
								color: 'warning'
							})}>Warning</Button
					>
					<Button size="sm" onclick={() => fire({ title: 'Domain verified', color: 'info' })}
						>Info</Button
					>
					<Button
						size="sm"
						onclick={() =>
							fire({
								title: 'Preview is ready',
								description: 'feat/sponsors deployed to its own URL.',
								color: 'info',
								action: { label: 'Open preview', onClick: () => {} }
							})}>Action</Button
					>
					<Button size="sm" onclick={fakeDeploy}>Promise</Button>
				</div>
				<Alert tone="warning" title="Memory is close to the limit"
					>worker has used 92% of 512 MB for 10 minutes.</Alert
				>
				<Alert tone="error" title="Build failed">
					Dependency install exited with code 1.
					{#snippet actions()}<Button size="sm">View logs</Button>{/snippet}
				</Alert>
				<div class="flex items-center gap-3 text-muted">
					<Spinner />
					<Spinner size={20} />
					<Skeleton width="8rem" height="0.75rem" />
				</div>
			</div>
		</SectionCard>
	</div>

	<SectionCard title="Inputs">
		<div class="grid grid-cols-3 gap-4">
			<Field label="App name" hint="Lowercase letters, numbers and dashes." for="g-name">
				<Input id="g-name" bind:value={name} />
			</Field>
			<Field label="Search" for="g-search">
				<Input id="g-search" icon={Search} placeholder="Search apps" />
			</Field>
			<Field label="Domain" error="That domain is already taken." for="g-domain">
				<Input id="g-domain" value="hackclub.com" error />
			</Field>
			<Field label="Region" for="g-region">
				<Select id="g-region" bind:value={region}>
					<option value="fsn1">Falkenstein</option>
					<option value="hel1">Helsinki</option>
					<option value="ash">Ashburn</option>
				</Select>
			</Field>
			<Field label="Range">
				<SegmentedControl
					label="Range"
					bind:value={seg}
					options={[
						{ value: 'hour', label: '1h' },
						{ value: 'day', label: '24h' },
						{ value: 'week', label: '7d' },
						{ value: 'month', label: '30d' }
					]}
				/>
			</Field>
			<Field label="Switch">
				<div class="flex items-center gap-3">
					<Switch bind:checked={on} label="Enabled" />
					<Switch disabled />
				</div>
			</Field>
		</div>
		<div class="mt-4 flex flex-col gap-4">
			<ToggleRow
				label="Deploy on push"
				hint="Every push to main builds and ships."
				bind:checked={autoDeploy}
			/>
		</div>
	</SectionCard>

	<SectionCard title="Tabs">
		<Tabs
			bind:value={tab}
			tabs={[
				{ id: 'overview', label: 'Overview' },
				{ id: 'logs', label: 'Logs' },
				{ id: 'metrics', label: 'Metrics' },
				{ id: 'settings', label: 'Settings', count: 2 }
			]}
		/>
	</SectionCard>

	<div class="grid grid-cols-2 gap-6">
		<div class="flex flex-col gap-3">
			<h2 class="text-headline text-fg">Lists and entities</h2>
			<List>
				{#each PROJECTS[0].entities.concat(PROJECTS[1].entities) as e (e.name)}
					<EntityRow {...e} href="#">
						{#snippet actions()}
							<Menu>
								{#snippet trigger(props)}<Button
										{...props}
										size="sm"
										variant="ghost"
										icon={Ellipsis}
										label="Actions"
									/>{/snippet}
								<MenuItem>Redeploy</MenuItem>
								<MenuItem>Copy URL</MenuItem>
								<MenuItem danger>Delete</MenuItem>
							</Menu>
						{/snippet}
					</EntityRow>
				{/each}
			</List>
			<List>
				<ListRow title="Plain row" subtitle="With a subtitle" />
				<ListRow title="Clickable row" subtitle="Whole row is the hit target" href="#">
					{#snippet trailing()}<RelativeTime date={Date.now() - 3 * 3600_000} />{/snippet}
				</ListRow>
			</List>
		</div>
		<div class="flex flex-col gap-3">
			<h2 class="text-headline text-fg">Cards and metrics</h2>
			<div class="grid grid-cols-2 gap-3">
				<Card><Metric label="CPU" value="0.42" unit="cores" detail="of 1 core" /></Card>
				<Card
					><Metric
						label="Memory"
						value="471"
						unit="MB"
						detail="92% of 512 MB"
						tone="warning"
					/></Card
				>
				<Card
					><Metric label="Requests" value="12.4k" detail="+8% vs yesterday" tone="success" /></Card
				>
				<Card href="#"><Metric label="Replicas" value="3" detail="Interactive card" /></Card>
			</div>
			<Card padding="none">
				<EmptyState
					title="No databases yet"
					description="Spin up Postgres or Redis next to your app in a few seconds."
				>
					{#snippet icon()}<Box size={18} />{/snippet}
					<Button variant="primary" size="sm" icon={Plus}>New database</Button>
				</EmptyState>
			</Card>
		</div>
	</div>

	<SectionCard title="Small things">
		<div class="flex flex-wrap items-center gap-6">
			<Tooltip text="Open command menu" shortcut="⌘K"
				><Button icon={Search} label="Search" /></Tooltip
			>
			<Kbd keys={['⌘', 'K']} />
			<span class="flex items-center gap-1 text-callout text-muted">
				<code class="font-mono">postgres://orchard@db:5432/app</code>
				<CopyButton value="postgres://orchard@db:5432/app" />
			</span>
			<span class="w-48 text-callout text-muted"
				><MiddleTruncate text="sha256:4f2a9c1b81e0d4aa93ce77f0128ab9e" mono /></span
			>
			<StatusDot meta={statusMeta('progress', 'Building', true)} />
			<Button size="sm" onclick={() => (modalOpen = true)}>Open modal</Button>
		</div>
	</SectionCard>

	<SectionCard title="Type">
		<div class="flex flex-col gap-2">
			<p class="text-display text-fg">Display 32</p>
			<p class="text-title-1 text-fg">Title 1 · 24</p>
			<p class="text-title-2 text-fg">Title 2 · 20</p>
			<p class="text-title-3 text-fg">Title 3 · 17</p>
			<p class="text-headline text-fg">Headline · 15</p>
			<p class="text-body text-fg">
				Body · 14. The quick brown fox deploys over the lazy dog, 0123456789.
			</p>
			<p class="text-callout text-muted">Callout · 13, muted</p>
			<p class="text-caption text-faint">Caption · 12, faint</p>
			<p class="font-mono text-callout text-fg">mono · ERROR 137 OOMKilled at 03:14:07</p>
		</div>
	</SectionCard>
</Page>

<Modal bind:open={modalOpen} title="Delete worker?" size="sm">
	<p class="text-body text-muted">
		This stops every replica and removes its domains. Logs are kept for 7 days.
	</p>
	{#snippet footer()}
		<Button onclick={() => (modalOpen = false)}>Cancel</Button>
		<Button variant="danger" onclick={() => (modalOpen = false)}>Delete worker</Button>
	{/snippet}
</Modal>

<DevBar />
<div class="h-24"></div>
