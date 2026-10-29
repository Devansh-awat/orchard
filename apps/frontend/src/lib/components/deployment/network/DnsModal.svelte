<script lang="ts">
	import { Globe } from 'lucide-svelte';
	import { Button, Modal, ModalIntro } from '$lib/components/ui';
	import DnsSetup from './DnsSetup.svelte';

	let {
		open = $bindable(false),
		host,
		cname,
		onCheckDns = undefined
	}: {
		open: boolean;
		host: string;
		cname: string;
		onCheckDns?: (domain: string) => Promise<{ valid: boolean; message: string }>;
	} = $props();

	const uid = $props.id();
</script>

<Modal bind:open size="md" closable={false} dismissable labelledby="{uid}-title">
	<div class="body">
		<ModalIntro id="{uid}-title" icon={Globe} title="DNS" description={host} />
		<DnsSetup {host} {cname} {onCheckDns} />
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
