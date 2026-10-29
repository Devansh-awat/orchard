<script lang="ts">
	import { ArrowUpRight, Copy, Ellipsis, Globe, PenLine, Shield, Trash2 } from 'lucide-svelte';
	import {
		Button,
		ListRow,
		Menu,
		MenuItem,
		MenuSeparator,
		StatusBadge,
		ToneTile
	} from '$lib/components/ui';
	import { ingressUrl } from '$lib/ingress-url';
	import { toasts } from '$lib/stores';
	import {
		PROTECTION_LABELS,
		certificateMeta,
		displayHost,
		protectionOf,
		redirectLabel
	} from './network';

	let {
		ingress,
		appDomain,
		canProtect,
		canEditRedirect,
		deleting,
		onProtection,
		onRedirect,
		onDns,
		onRemove
	}: {
		ingress: any;
		appDomain: string;
		canProtect: boolean;
		canEditRedirect: boolean;
		deleting: boolean;
		onProtection: (ingress: any) => void;
		onRedirect: (ingress: any) => void;
		onDns: (ingress: any) => void;
		onRemove: (ingress: any) => void;
	} = $props();

	const url = $derived(ingressUrl(ingress));
	const cert = $derived(certificateMeta(ingress));
	const custom = $derived(!appDomain || !String(ingress.host).endsWith(`.${appDomain}`));
	const facts = $derived.by(() => {
		if (ingress.redirectTarget)
			return `Redirects to ${redirectLabel(ingress)} · ${ingress.redirectStatus ?? 307}`;
		return [
			ingress.tlsEnabled === false ? 'HTTP only' : 'HTTPS',
			PROTECTION_LABELS[protectionOf(ingress)]
		]
			.filter(Boolean)
			.join(' · ');
	});

	async function copy() {
		await navigator.clipboard.writeText(url);
		toasts.add({ title: 'Copied URL', description: url, color: 'success' });
	}
</script>

<ListRow flush pinned presence title={displayHost(ingress)} subtitle={facts}>
	{#snippet leading()}
		<ToneTile size={28} label="Domain"><Globe size={14} /></ToneTile>
	{/snippet}
	{#snippet titleSuffix()}
		{#if cert}<StatusBadge meta={cert} variant="plain" />{/if}
	{/snippet}
	{#snippet actions()}
		<span class="acts">
			<Button
				variant="ghost"
				size="sm"
				icon={ArrowUpRight}
				label="Open {ingress.host}"
				href={url}
				target="_blank"
				rel="noopener noreferrer"
			/>
			<Menu placement="bottom-end">
				{#snippet trigger(props)}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						icon={Ellipsis}
						label="Domain actions"
						loading={deleting}
					/>
				{/snippet}
				<MenuItem icon={Copy} onclick={copy}>Copy URL</MenuItem>
				{#if ingress.redirectTarget}
					{#if canEditRedirect}
						<MenuItem icon={PenLine} onclick={() => onRedirect(ingress)}>Edit redirect…</MenuItem>
					{/if}
				{:else if canProtect}
					<MenuItem icon={Shield} onclick={() => onProtection(ingress)}>Who can visit…</MenuItem>
				{/if}
				{#if custom}
					<MenuItem icon={Globe} onclick={() => onDns(ingress)}>DNS…</MenuItem>
				{/if}
				<MenuSeparator />
				<MenuItem icon={Trash2} danger onclick={() => onRemove(ingress)}>Remove domain</MenuItem>
			</Menu>
		</span>
	{/snippet}
</ListRow>

<style>
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-right: -0.4375rem;
	}
</style>
