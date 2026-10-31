<script lang="ts">
	import { apiFetch } from '$lib/stores';
	import { SecretString, SegmentedControl } from '$lib/components/ui';
	import type { DatabaseDetail } from './types';

	let {
		database,
		settingsHref,
		onnavigate = undefined
	}: { database: DatabaseDetail; settingsHref: string; onnavigate?: () => void } = $props();

	type Format = 'uri' | 'psql' | 'env' | 'jdbc';
	type Endpoint = 'rw' | 'ro' | 'r';

	let format = $state<Format>('uri');
	let endpoint = $state<Endpoint>('rw');

	const MASK = '••••••••';
	const isPostgres = $derived(database.mode !== 'shared' || !!database.dbName);
	const standbys = $derived(Math.max(0, (database.replicas ?? 1) - 1));
	const endpoints = $derived(database.endpoints ?? null);

	const host = $derived(
		endpoints && endpoint !== 'rw' ? (endpoints[endpoint] ?? database.host) : database.host
	);

	function render(password: string) {
		const uri = `postgresql://${database.dbUser}:${password}@${host}:${database.port}/${database.dbName}`;
		if (format === 'psql') return `psql "${uri}"`;
		if (format === 'env') return `DATABASE_URL="${uri}"`;
		if (format === 'jdbc')
			return `jdbc:postgresql://${host}:${database.port}/${database.dbName}?user=${database.dbUser}&password=${password}`;
		return uri;
	}

	const masked = $derived(render(MASK));

	async function resolve() {
		const res = await apiFetch(`/apiv1/databases/${database.id}/connection`);
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		return data?.password ? render(data.password) : null;
	}

	const where = $derived(
		database.publicEnabled ? 'Reachable from the internet' : 'Private to apps in this project'
	);
</script>

<div class="connect">
	<SegmentedControl
		label="Connection format"
		grow
		bind:value={() => format, (v) => (format = v as Format)}
		options={[
			{ value: 'uri', label: 'URI' },
			{ value: 'psql', label: 'psql' },
			{ value: 'env', label: '.env' },
			{ value: 'jdbc', label: 'JDBC' }
		]}
	/>
	{#if isPostgres && endpoints}
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
	<p class="where">
		{where} · <a href={settingsHref} onclick={onnavigate}>Public access</a>
	</p>
	<p class="where">
		Apps in this project don't need to copy this: open an app's Variables and choose Use a resource.
	</p>
</div>

<style>
	.connect {
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
