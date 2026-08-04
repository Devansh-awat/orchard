<script lang="ts">
	import { Plus, Sprout } from 'lucide-svelte';
	import { Button, EmptyState } from '$lib/components/ui';

	let { oncreate }: { oncreate: () => void } = $props();
</script>

<EmptyState
	title="No sandboxes yet"
	description="A sandbox is an isolated cloud dev VM with SSH access and coding agents preinstalled. It can reach the internet but nothing else on the cluster, so agents can run unattended with zero blast radius."
>
	{#snippet icon()}<Sprout size={28} />{/snippet}
	<Button variant="primary" onclick={oncreate}>
		<Plus class="h-4 w-4" /> New sandbox
	</Button>
</EmptyState>
