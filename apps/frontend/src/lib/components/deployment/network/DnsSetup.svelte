<script lang="ts">
	import { untrack } from 'svelte';
	import { Button, StatusBadge } from '$lib/components/ui';
	import { statusMeta } from '$lib/components/ui/status';
	import DnsRecord from '$lib/components/ui/DnsRecord.svelte';
	import { dnsRecordName } from './network';

	let {
		host,
		cname,
		onCheckDns = undefined
	}: {
		host: string;
		cname: string;
		onCheckDns?: (domain: string) => Promise<{ valid: boolean; message: string }>;
	} = $props();

	let phase = $state<'idle' | 'checking' | 'valid' | 'invalid'>('idle');

	$effect(() => {
		void host;
		untrack(() => (phase = 'idle'));
	});

	const name = $derived(host ? dnsRecordName(host) : '@');
	const meta = $derived(
		phase === 'valid'
			? statusMeta('success', 'Record found')
			: phase === 'invalid'
				? statusMeta('warning', 'Not found yet')
				: null
	);

	async function check() {
		if (!onCheckDns || !host) return;
		phase = 'checking';
		try {
			const result = await onCheckDns(host);
			phase = result.valid ? 'valid' : 'invalid';
		} catch {
			phase = 'invalid';
		}
	}
</script>

<div class="dns-setup">
	{#if cname}
		<DnsRecord records={[{ type: 'CNAME', name, value: cname }]} />
	{/if}
	<div class="foot">
		<p class="note">
			{#if !cname}
				Point this domain at your cluster's ingress.
			{:else if host && name === '@'}
				Root domains need CNAME flattening, like Cloudflare offers.
			{:else}
				Works as soon as the record is live.
			{/if}
		</p>
		<div class="check">
			{#if meta}<StatusBadge {meta} variant="plain" />{/if}
			{#if onCheckDns}
				<Button
					variant="secondary"
					size="sm"
					loading={phase === 'checking'}
					disabled={!host}
					onclick={check}>Check</Button
				>
			{/if}
		</div>
	</div>
</div>

<style>
	.dns-setup {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 1.75rem;
	}
	.note {
		min-width: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.check {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.75rem;
	}
</style>
