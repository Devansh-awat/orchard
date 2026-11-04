<script lang="ts">
	import {
		Alert,
		Button,
		Field,
		FieldGrid,
		FormActions,
		Input,
		List,
		ListRow,
		SecretInput,
		SectionCard,
		Stack,
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
	const connected = $derived(!!state?.configured && !state.error);
</script>

{#snippet headerActions()}
	<StatusBadge meta={statusMeta('success', `Connected to ${state?.tunnelName ?? 'this tunnel'}`)} />
{/snippet}

<SectionCard
	title="Cloudflare Tunnel"
	description="Add an API token to see which hostnames reach this tunnel and add routes from here."
	actions={connected ? headerActions : undefined}
>
	<Stack gap="lg">
		{#if state?.error}
			<Alert tone="error" title="Cloudflare rejected the request">{state.error}</Alert>
		{/if}

		{#if connected && state}
			{#if state.routes.length}
				<div class="routes">
					<List inset={false} label="Tunnel routes">
						{#each state.routes as route (route.record)}
							<ListRow flush pinned title={route.record} subtitle={route.label}>
								{#snippet actions()}
									{#if route.routed}
										<StatusBadge meta={statusMeta('success', 'Routed')} />
									{:else}
										<Button
											variant="secondary"
											size="sm"
											loading={routing === route.record}
											onclick={() => onRoute(route.record)}
										>
											Add route
										</Button>
									{/if}
								{/snippet}
							</ListRow>
						{/each}
					</List>
				</div>
			{/if}

			{#if state.otherHostnames.length}
				<p class="note">Also on this tunnel: {state.otherHostnames.join(', ')}</p>
			{/if}

			{#if !state.canEditDns}
				<Alert tone="info" title="No zone ID">
					Orchard adds the route but not the DNS record. Point each hostname at
					<code class="code">{'<tunnel-id>'}.cfargotunnel.com</code> yourself, or add the zone ID below.
				</Alert>
			{/if}
		{/if}

		{#if section}
			{#if allLocked}
				<Alert tone="info" title="Set by the environment">
					Every field here comes from an environment variable, so you can't change it here.
				</Alert>
			{:else}
				<Stack gap="sm">
					<FieldGrid>
						{#each Object.entries(FIELDS) as [name, field] (name)}
							{@const locked = section.lockedFields.includes(name)}
							{@const secret = section.secretFields.includes(name)}
							<Field
								label={field.label}
								for="tunnel-{name}"
								hint={locked ? 'Set by the environment' : field.hint}
							>
								{#if secret}
									<SecretInput
										id="tunnel-{name}"
										disabled={locked}
										placeholder={section.configured ? 'Unchanged' : ''}
										bind:value={draft[name]}
									/>
								{:else}
									<Input id="tunnel-{name}" disabled={locked} bind:value={draft[name]} />
								{/if}
							</Field>
						{/each}
					</FieldGrid>
					<FormActions>
						<Button variant="primary" loading={saving} onclick={onSave}>Save</Button>
					</FormActions>
				</Stack>
			{/if}
		{/if}
	</Stack>
</SectionCard>

<style>
	.routes {
		margin-block: -0.75rem;
	}
	.note {
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
	.code {
		font-family: var(--font-mono);
		font-size: 0.92em;
	}
</style>
