<script lang="ts">
	import {
		ArrowUpRight,
		Copy,
		CornerUpRight,
		Ellipsis,
		Globe,
		PenLine,
		Plus,
		Server,
		Shield,
		ShieldCheck,
		Trash2
	} from 'lucide-svelte';
	import {
		Badge,
		Button,
		List,
		ListRow,
		Menu,
		MenuItem,
		MenuSeparator,
		StatusDot,
		ToneTile
	} from '$lib/components/ui';
	import Widget from '$lib/components/ui/Widget.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import { ingressUrl } from '$lib/ingress-url';
	import { toasts } from '$lib/stores';
	import { PROTECTION_LABELS, certificateMeta, protectionOf, redirectLabel } from './network';

	let {
		domains,
		appDomain,
		portOf,
		canAdd,
		canProtect,
		canEditRedirect,
		deletingIngressId,
		sharedWith,
		onAdd,
		onProtection,
		onRedirect,
		onDns,
		onRemove
	}: {
		domains: any[];
		appDomain: string;
		portOf: (ingress: any) => number | null;
		canAdd: boolean;
		canProtect: boolean;
		canEditRedirect: boolean;
		deletingIngressId: string | null;
		sharedWith: (ingress: any) => string | null;
		onAdd: () => void;
		onProtection: (ingress: any) => void;
		onRedirect: (ingress: any) => void;
		onDns: (ingress: any) => void;
		onRemove: (ingress: any) => void;
	} = $props();

	const live = statusMeta('success', 'Live');

	function isCustom(ingress: any) {
		return !appDomain || !String(ingress.host).endsWith(`.${appDomain}`);
	}

	function title(ingress: any) {
		return `${ingress.host}${ingress.path && ingress.path !== '/' ? ingress.path : ''}`;
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toasts.add({ title: 'Copied', description: text, color: 'success' });
	}
</script>

<Widget title="Domains">
	{#snippet meta()}
		{#if canAdd}
			<Button variant="ghost" size="sm" icon={Plus} class="net-add" onclick={onAdd}
				>Add domain</Button
			>
		{/if}
	{/snippet}

	{#if domains.length === 0}
		<div class="empty">
			<span>No domains yet</span>
		</div>
	{:else}
		<List inset={false} label="Domains">
			{#each domains as ingress (ingress.id)}
				{@const status = ingress.redirectTarget ? null : (certificateMeta(ingress) ?? live)}
				{@const port = portOf(ingress)}
				{@const shared = sharedWith(ingress)}
				{@const protection = protectionOf(ingress)}
				<ListRow flush pinned presence title={title(ingress)}>
					{#snippet leading()}
						{#if ingress.redirectTarget}
							<ToneTile tone="neutral" solid size={32}
								><CornerUpRight size={15} strokeWidth={2.25} /></ToneTile
							>
						{:else}
							<ToneTile tone="info" solid size={32}><Globe size={15} strokeWidth={2.25} /></ToneTile
							>
						{/if}
					{/snippet}
					{#snippet subtitle()}
						<span class="sub">
							{#if ingress.redirectTarget}
								<span>Redirects to {redirectLabel(ingress)}</span>
							{:else if status}
								<StatusDot meta={status} /><span>{status.label}</span>
							{/if}
							{#if port}
								<span class="sep">·</span>
								<span class="to"><Server size={11} aria-hidden="true" />Port {port}</span>
							{/if}
							{#if shared}<span class="sep">·</span><span>{shared}</span>{/if}
						</span>
					{/snippet}
					{#snippet actions()}
						<span class="acts">
							{#if !ingress.redirectTarget && canProtect}
								{#if protection === 'none'}
									<Button
										variant="secondary"
										size="sm"
										icon={Shield}
										class="net-pill"
										onclick={() => onProtection(ingress)}>Add protection</Button
									>
								{:else}
									<button type="button" class="guard" onclick={() => onProtection(ingress)}>
										<Badge tone="success"
											><ShieldCheck size={12} strokeWidth={2.25} />{PROTECTION_LABELS[
												protection
											]}</Badge
										>
									</button>
								{/if}
							{/if}
							<Button
								variant="ghost"
								size="sm"
								icon={ArrowUpRight}
								label="Open {ingress.host}"
								href={ingressUrl(ingress)}
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
										label="{ingress.host} actions"
										loading={deletingIngressId === ingress.id}
									/>
								{/snippet}
								<MenuItem icon={Copy} onclick={() => copy(ingressUrl(ingress))}>Copy link</MenuItem>
								{#if ingress.redirectTarget && canEditRedirect}
									<MenuItem icon={PenLine} onclick={() => onRedirect(ingress)}
										>Edit redirect…</MenuItem
									>
								{/if}
								{#if isCustom(ingress)}
									<MenuItem icon={Globe} onclick={() => onDns(ingress)}>DNS setup…</MenuItem>
								{/if}
								<MenuSeparator />
								<MenuItem icon={Trash2} danger onclick={() => onRemove(ingress)}
									>Remove domain</MenuItem
								>
							</Menu>
						</span>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</Widget>

<style>
	.sub {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}
	.sep {
		color: var(--text-faint);
	}
	.to {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-right: -0.4375rem;
	}
	.guard {
		display: inline-flex;
		margin-right: 0.25rem;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
	}
	.guard:focus-visible {
		outline: none;
		border-radius: 0.375rem;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.empty {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 3rem;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
</style>
