<script lang="ts">
	import { apiFetch } from '$lib/stores';
	import { ActionRow, Button, SecretString, SegmentedControl, Swap } from '$lib/components/ui';
	import PublicAddressLine from '$lib/components/deployment/network/PublicAddressLine.svelte';
	import { formatConnection, parsePublicAddress, type ConnectionFormat } from './connection';
	import type { DatabaseDetail } from './types';

	let {
		database,
		settingsHref,
		onnavigate = undefined,
		onenablepublic = undefined,
		enabling = false
	}: {
		database: DatabaseDetail;
		settingsHref: string;
		onnavigate?: () => void;
		onenablepublic?: () => void;
		enabling?: boolean;
	} = $props();

	type Network = 'private' | 'public';
	type Endpoint = 'rw' | 'ro' | 'r';

	let chosenNetwork = $state<Network | null>(null);
	let format = $state<ConnectionFormat>('uri');
	let endpoint = $state<Endpoint>('rw');

	const MASK = '••••••••';
	const canBePublic = $derived(database.mode === 'cnpg');
	const network = $derived<Network>(
		chosenNetwork ?? (canBePublic && database.publicEnabled ? 'public' : 'private')
	);
	const publicAddress = $derived(parsePublicAddress(database.publicConnectionString));
	const publicReady = $derived(!!database.publicEnabled && !!publicAddress);
	const publicWaiting = $derived(
		database.publicStatus?.state === 'pending' || database.publicStatus?.state === 'failed'
	);
	const view = $derived(
		network !== 'public' ? 'on' : !publicReady ? 'off' : publicWaiting ? 'waiting' : 'on'
	);
	const isPostgres = $derived(database.mode !== 'shared' || !!database.dbName);
	const standbys = $derived(Math.max(0, (database.replicas ?? 1) - 1));
	const endpoints = $derived(database.endpoints ?? null);

	const privateHost = $derived(
		endpoints && endpoint !== 'rw' ? (endpoints[endpoint] ?? database.host) : database.host
	);
	const target = $derived(
		network === 'public' && publicAddress
			? {
					user: database.dbUser,
					host: publicAddress.host,
					port: publicAddress.port,
					database: database.dbName,
					query: publicAddress.query
				}
			: {
					user: database.dbUser,
					host: privateHost,
					port: database.port,
					database: database.dbName
				}
	);

	const masked = $derived(formatConnection(format, target, MASK));

	async function resolve() {
		const res = await apiFetch(`/apiv1/databases/${database.id}/connection`);
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		return data?.password ? formatConnection(format, target, data.password) : null;
	}
</script>

<div class="connect">
	{#if canBePublic}
		<SegmentedControl
			label="Where you connect from"
			grow
			bind:value={() => network, (v) => (chosenNetwork = v as Network)}
			options={[
				{ value: 'private', label: 'Private', hint: 'From apps in this project' },
				{ value: 'public', label: 'Public', hint: 'From anywhere on the internet' }
			]}
		/>
	{/if}
	<Swap key={view}>
		{#if view === 'waiting'}
			<div class="details">
				<PublicAddressLine address={null} status={database.publicStatus} />
				<p class="where">
					<a href={settingsHref} onclick={onnavigate}>Manage public access</a>
				</p>
			</div>
		{:else if view === 'off'}
			<ActionRow
				label="Public access is off"
				hint="Turn it on to connect from your computer or another host. Anyone with the password can connect."
			>
				<Button variant="primary" loading={enabling} onclick={() => onenablepublic?.()}>
					Turn on
				</Button>
			</ActionRow>
		{:else}
			<div class="details">
				<SegmentedControl
					label="Connection format"
					size="sm"
					grow
					bind:value={() => format, (v) => (format = v as ConnectionFormat)}
					options={[
						{ value: 'uri', label: 'URI' },
						{ value: 'psql', label: 'psql' },
						{ value: 'env', label: '.env' },
						{ value: 'jdbc', label: 'JDBC' }
					]}
				/>
				{#if network === 'private' && isPostgres && endpoints}
					<SegmentedControl
						label="Which instances"
						size="sm"
						grow
						bind:value={() => endpoint, (v) => (endpoint = v as Endpoint)}
						options={[
							{ value: 'rw', label: 'Primary', hint: 'Reads and writes, follows a failover' },
							{
								value: 'ro',
								label: 'Standbys',
								hint: 'Read only, load balanced',
								disabled: standbys === 0
							},
							{ value: 'r', label: 'Any', hint: 'Read only, every instance' }
						]}
					/>
				{/if}
				<SecretString {masked} {resolve} label="Connection string" />
				{#if network === 'public'}
					<p class="where">
						Anyone with the password can connect. <a href={settingsHref} onclick={onnavigate}
							>Manage public access</a
						>
					</p>
				{:else}
					<p class="where">
						Only works from apps in this project. They don't need to copy this: open an app's
						Variables and choose Use a resource.
					</p>
				{/if}
			</div>
		{/if}
	</Swap>
</div>

<style>
	.connect,
	.details {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.where {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}
	.where a {
		color: var(--text-default);
		text-decoration: underline;
		text-decoration-color: var(--border-default);
		text-underline-offset: 2px;
	}
	.where a:hover {
		text-decoration-color: currentColor;
	}
</style>
