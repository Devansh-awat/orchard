<script lang="ts">
	import { Globe } from 'lucide-svelte';
	import { Button, Modal, ModalIntro } from '$lib/components/ui';
	import DnsSetup from './DnsSetup.svelte';
	import type { DnsCheck } from './network';

	let {
		open = $bindable(false),
		host,
		onCheckDns = undefined
	}: {
		open: boolean;
		host: string;
		onCheckDns?: (domain: string) => Promise<DnsCheck>;
	} = $props();

	const uid = $props.id();
</script>

<Modal bind:open size="md" closable={false} dismissable labelledby="{uid}-title">
	<div class="body">
		<ModalIntro
			id="{uid}-title"
			icon={Globe}
			tone="info"
			solid
			title="Set up DNS"
			description={host}
		/>
		<DnsSetup {host} watch={open} {onCheckDns} />
	</div>
	{#snippet footer()}
		<Button variant="primary" onclick={() => (open = false)}>Done</Button>
	{/snippet}
</Modal>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
</style>
