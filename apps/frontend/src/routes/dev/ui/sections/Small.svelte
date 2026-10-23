<script lang="ts">
	import { Search } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import MiddleTruncate from '$lib/components/ui/MiddleTruncate.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import { statusMeta } from '$lib/components/ui/status';

	let modalOpen = $state(false);
</script>

<SectionCard title="Small things">
	<div class="flex flex-wrap items-center gap-6">
		<Tooltip text="Open command menu" shortcut="⌘K"><Button icon={Search} label="Search" /></Tooltip
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

<Modal bind:open={modalOpen} title="Delete worker?" size="sm">
	<p class="text-body text-muted">
		This stops every replica and removes its domains. Logs are kept for 7 days.
	</p>
	{#snippet footer()}
		<Button onclick={() => (modalOpen = false)}>Cancel</Button>
		<Button variant="danger" onclick={() => (modalOpen = false)}>Delete worker</Button>
	{/snippet}
</Modal>
