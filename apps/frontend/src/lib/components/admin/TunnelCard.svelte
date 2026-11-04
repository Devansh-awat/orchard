<script lang="ts">
	import { Cloud } from 'lucide-svelte';
	import {
		Alert,
		Badge,
		Button,
		Field,
		Input,
		SectionCard,
		StatusBadge,
		statusMeta
	} from '$lib/components/ui';

	export interface TunnelRoute {
		role: string;
		record: string;
		label: string;
		routed: boolean;
		service: string | null;
	}

	export interface TunnelState {
		configured: boolean;
		error: string | null;
		tunnelName: string | null;
		canEditDns: boolean;
		routes: TunnelRoute[];
		otherHostnames: string[];
	}

	export interface TunnelSection {
		id: string;
		configured: boolean;
		values: Record<string, string | null>;
		lockedFields: string[];
		secretFields: string[];
	}

	let {
		state,
		section,
		draft = $bindable({}),
		saving = false,
		routing = null,
		onSave,
		onRoute
	}: {
		state: TunnelState | null;
		section: TunnelSection | null;
		draft: Record<string, string>;
		saving?: boolean;
		routing?: string | null;
		onSave: () => void;
		onRoute: (hostname: string) => void;
	} = $props();

	const FIELDS: Record<string, { label: string; hint: string }> = {
		apiToken: {
			label: 'API token',
			hint: 'Needs Account / Cloudflare Tunnel / Edit, and Zone / DNS / Edit to create records'
		},
		accountId: { label: 'Account ID', hint: 'On the right of any Cloudflare dashboard page' },
		tunnelId: { label: 'Tunnel ID', hint: 'Zero Trust, Networks, Tunnels, then the tunnel' },
		zoneId: { label: 'Zone ID', hint: 'Optional. Without it, you create DNS records yourself' }
	};

	const allLocked = $derived(
		section ? section.lockedFields.length === Object.keys(FIELDS).length : false
	);
</script>

<SectionCard
	title="Cloudflare Tunnel"
	description="A token-managed tunnel keeps its routes in Cloudflare, so this server can't see which hostnames reach it. Add an API token to see them and add routes here."
>
	{#if state?.error}
		<Alert tone="error" title="Cloudflare rejected the request">{state.error}</Alert>
	{/if}

	{#if state?.configured && !state.error}
		<div class="tn-summary">
			<Cloud size={15} />
			<span>Connected to <strong>{state.tunnelName ?? 'this tunnel'}</strong></span>
			{#if !state.canEditDns}
				<Badge tone="neutral">no zone ID</Badge>
			{/if}
		</div>

		<ul class="tn-routes">
			{#each state.routes as route (route.record)}
				<li class="tn-route">
					<div class="tn-route-main">
						<code class="tn-host">{route.record}</code>
						<span class="tn-role">{route.label}</span>
					</div>
					{#if route.routed}
						<StatusBadge meta={statusMeta('success', 'Routed')} />
					{:else}
						<Button
							variant="secondary"
							loading={routing === route.record}
							onclick={() => onRoute(route.record)}
						>
							Add route
						</Button>
					{/if}
				</li>
			{/each}
		</ul>

		{#if state.otherHostnames.length}
			<p class="tn-other">
				Also on this tunnel: {state.otherHostnames.join(', ')}
			</p>
		{/if}

		{#if !state.canEditDns}
			<p class="tn-other">
				Without a zone ID, Orchard adds the route but not the DNS record. Point each hostname at
				<code>{'<tunnel-id>'}.cfargotunnel.com</code> yourself, or add the zone ID below.
			</p>
		{/if}
	{/if}

	{#if section}
		{#if allLocked}
			<Alert tone="info" title="Set by the environment">
				Every field here comes from an environment variable, so you can't change it here.
			</Alert>
		{:else}
			<div class="tn-fields">
				{#each Object.entries(FIELDS) as [name, field] (name)}
					{@const locked = section.lockedFields.includes(name)}
					{@const secret = section.secretFields.includes(name)}
					<Field
						label={field.label}
						for="tunnel-{name}"
						hint={locked ? 'Set by the environment' : field.hint}
					>
						<Input
							id="tunnel-{name}"
							type={secret ? 'password' : 'text'}
							disabled={locked}
							placeholder={secret && section.configured ? 'Unchanged' : ''}
							bind:value={draft[name]}
						/>
					</Field>
				{/each}
			</div>
			<div class="tn-actions">
				<Button variant="primary" loading={saving} onclick={onSave}>Save</Button>
			</div>
		{/if}
	{/if}
</SectionCard>

<style>
	.tn-summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		color: var(--text-muted);
		margin-bottom: 0.85rem;
	}

	.tn-routes {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.85rem;
	}

	.tn-route {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--border-edge);
		border-radius: var(--radius-md);
		background-color: var(--bg-raised);
	}

	.tn-route-main {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.tn-host {
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-fg);
		word-break: break-all;
	}

	.tn-role,
	.tn-other {
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--text-faint);
	}

	.tn-other {
		margin-bottom: 0.85rem;
	}

	.tn-fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.85rem;
	}

	.tn-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 1.25rem;
	}
</style>
