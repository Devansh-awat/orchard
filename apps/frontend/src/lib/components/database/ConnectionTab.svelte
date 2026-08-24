<script lang="ts">
	import { Copy, Check, Eye, EyeOff } from 'lucide-svelte';
	import { selectedOrganization } from '$lib/stores';
	import { Button, Badge, SectionCard, SegmentedControl } from '$lib/components/ui';
	import type { DatabaseDetail } from './types';

	let {
		database,
		orgSlug,
		copiedField = $bindable(),
		showPassword = $bindable(),
		showConnectionString = $bindable(),
		showPublicConnectionString = $bindable(),
		togglingPublic,
		onEnablePublic,
		onDisablePublic,
		onCopy
	}: {
		database: DatabaseDetail;
		orgSlug: string;
		copiedField: string | null;
		showPassword: boolean;
		showConnectionString: boolean;
		showPublicConnectionString: boolean;
		togglingPublic: boolean;
		onEnablePublic: () => void;
		onDisablePublic: () => void;
		onCopy: (text: string, field: string) => void;
	} = $props();

	const canManageOrg = $derived(
		$selectedOrganization?.myRole === 'owner' || $selectedOrganization?.myRole === 'admin'
	);

	let connFormat = $state<'uri' | 'psql' | 'env' | 'jdbc'>('uri');

	const maskedUri = $derived(
		`postgresql://${database.dbUser}:••••••••@${database.host}:${database.port}/${database.dbName}`
	);
	const visibleUri = $derived(showConnectionString ? database.connectionString : maskedUri);
	const snippet = $derived.by(() => {
		const uri = visibleUri;
		if (connFormat === 'psql') return `psql "${uri}"`;
		if (connFormat === 'env') return `DATABASE_URL="${uri}"`;
		if (connFormat === 'jdbc') {
			const pw = showConnectionString ? database.dbPassword : '••••••••';
			return `jdbc:postgresql://${database.host}:${database.port}/${database.dbName}?user=${database.dbUser}&password=${pw}`;
		}
		return uri;
	});
	const copySnippet = $derived.by(() => {
		const uri = database.connectionString;
		if (connFormat === 'psql') return `psql "${uri}"`;
		if (connFormat === 'env') return `DATABASE_URL="${uri}"`;
		if (connFormat === 'jdbc') {
			return `jdbc:postgresql://${database.host}:${database.port}/${database.dbName}?user=${database.dbUser}&password=${database.dbPassword}`;
		}
		return uri;
	});

	const FORMATS = [
		{ id: 'uri', label: 'URI' },
		{ id: 'psql', label: 'psql' },
		{ id: 'env', label: '.env' },
		{ id: 'jdbc', label: 'JDBC' }
	] as const;

	const instances = $derived(Math.max(1, database.replicas ?? 1));

	// CNPG publishes one service per read/write role. -ro exists on a
	// single-instance cluster but has no endpoints behind it, so it is shown
	// dimmed rather than hidden: it becomes live the moment a standby joins.
	const endpointRows = $derived.by(() => {
		const e = database.endpoints;
		if (!e) return [];
		return [
			{
				key: 'rw',
				host: e.rw,
				label: 'Read-write',
				note: 'Always the current primary, and it follows a failover. Writes must use this.',
				idle: false
			},
			{
				key: 'ro',
				host: e.ro,
				label: 'Read-only',
				note:
					instances > 1
						? 'Standbys only, load balanced across them. Replication lag means reads can be slightly stale.'
						: 'Standbys only. Nothing answers here until this cluster runs more than one instance.',
				idle: instances < 2
			},
			{
				key: 'r',
				host: e.r,
				label: 'Read',
				note: 'Every instance including the primary, load balanced. Safe to use at any size.',
				idle: false
			}
		];
	});

	function endpointUri(host: string) {
		const pw = showConnectionString ? database.dbPassword : '••••••••';
		return `postgresql://${database.dbUser}:${pw}@${host}:${database.port}/${database.dbName}`;
	}

	function endpointCopyUri(host: string) {
		return `postgresql://${database.dbUser}:${database.dbPassword}@${host}:${database.port}/${database.dbName}`;
	}

	const dlRows = $derived([
		{ key: 'host', label: 'Host', value: database.host, copy: database.host },
		{ key: 'port', label: 'Port', value: String(database.port), copy: String(database.port) },
		{ key: 'database', label: 'Database', value: database.dbName, copy: database.dbName },
		{ key: 'user', label: 'User', value: database.dbUser, copy: database.dbUser },
		{
			key: 'password',
			label: 'Password',
			value: showPassword ? database.dbPassword : '••••••••',
			copy: database.dbPassword
		}
	]);
</script>

{#snippet formatChips()}
	<SegmentedControl
		label="Connection format"
		value={connFormat}
		onchange={(next) => (connFormat = next as typeof connFormat)}
		options={FORMATS.map((f) => ({ value: f.id, label: f.label }))}
	/>
{/snippet}

{#snippet detailList()}
	<dl class="dbc-dl">
		{#each dlRows as row (row.key)}
			<div class="dbc-dl-row">
				<dt class="dbc-dt">{row.label}</dt>
				<dd class="dbc-dd">
					<button
						type="button"
						class="dbc-dd-copy"
						onclick={() => onCopy(row.copy, row.key)}
						aria-label={`Copy ${row.label.toLowerCase()}`}
					>
						<span class="dbc-dd-value">{row.value}</span>
						{#if copiedField === row.key}<Check class="h-3 w-3" />{:else}<Copy
								class="dbc-dd-icon h-3 w-3"
							/>{/if}
					</button>
					{#if row.key === 'password'}
						<button
							type="button"
							class="dbc-reveal"
							onclick={() => (showPassword = !showPassword)}
							aria-label={showPassword ? 'Hide password' : 'Show password'}
						>
							{#if showPassword}<EyeOff class="h-3 w-3" />{:else}<Eye class="h-3 w-3" />{/if}
						</button>
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
{/snippet}

<div class="space-y-5">
	<div class="dbc-fused">
		<div class="dbc-fused-head">
			{@render formatChips()}
		</div>
		<div class="dbc-fused-body">
			<code class="dbc-fused-code">{snippet}</code>
			<div class="dbc-uri-actions">
				<Button
					variant="ghost"
					size="sm"
					onclick={() => (showConnectionString = !showConnectionString)}
					aria-label={showConnectionString ? 'Hide credentials' : 'Show credentials'}
				>
					{#if showConnectionString}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye
							class="h-3.5 w-3.5"
						/>{/if}
				</Button>
				<Button
					variant="secondary"
					size="sm"
					onclick={() => onCopy(copySnippet, 'connstr')}
					aria-label="Copy connection string"
				>
					{#if copiedField === 'connstr'}<Check class="h-3.5 w-3.5" />{:else}<Copy
							class="h-3.5 w-3.5"
						/>{/if}
					Copy
				</Button>
			</div>
		</div>
		<div class="dbc-fused-footer">
			{@render detailList()}
		</div>
	</div>

	{#if endpointRows.length > 0}
		<SectionCard
			title="Cluster endpoints"
			description="Three in-cluster hostnames route to different members of the cluster. Point writes at read-write and spread reads across the others."
		>
			<div class="dbc-eps">
				{#each endpointRows as ep (ep.key)}
					<div class="dbc-ep" class:dbc-ep--idle={ep.idle}>
						<div class="dbc-ep-head">
							<Badge tone={ep.key === 'rw' ? 'info' : 'neutral'}>{ep.label}</Badge>
							<code class="dbc-ep-suffix">-{ep.key}</code>
						</div>
						<div class="dbc-ep-row">
							<code class="dbc-ep-uri">{endpointUri(ep.host)}</code>
							<Button
								variant="ghost"
								size="sm"
								class="shrink-0"
								onclick={() => onCopy(endpointCopyUri(ep.host), `ep-${ep.key}`)}
								aria-label={`Copy ${ep.label.toLowerCase()} connection string`}
							>
								{#if copiedField === `ep-${ep.key}`}<Check class="h-3.5 w-3.5" />{:else}<Copy
										class="h-3.5 w-3.5"
									/>{/if}
							</Button>
						</div>
						<p class="dbc-ep-note">{ep.note}</p>
					</div>
				{/each}
			</div>
		</SectionCard>
	{/if}

	{#if database.mode === 'cnpg'}
		<SectionCard
			title="Public access"
			description="Expose this database on a shared organization IP with a unique port."
		>
			{#snippet actions()}
				{#if database.publicEnabled}
					<Button variant="secondary" size="sm" onclick={onDisablePublic} loading={togglingPublic}>
						Disable
					</Button>
				{:else}
					<Button variant="primary" size="sm" onclick={onEnablePublic} loading={togglingPublic}>
						Enable
					</Button>
				{/if}
			{/snippet}

			{#if database.publicEnabled && database.publicIp && database.publicPort}
				<div class="db-kv-grid">
					<span class="db-kv-label">Public host</span>
					<div class="db-kv-value">
						<code class="db-kv-code">{database.publicHostname || database.publicIp}</code>
						<Button
							variant="ghost"
							size="sm"
							class="shrink-0"
							onclick={() =>
								onCopy((database.publicHostname || database.publicIp) as string, 'pubHost')}
							aria-label="Copy host"
						>
							{#if copiedField === 'pubHost'}<Check class="h-3.5 w-3.5" />{:else}<Copy
									class="h-3.5 w-3.5"
								/>{/if}
						</Button>
					</div>

					<span class="db-kv-label">Public port</span>
					<div class="db-kv-value">
						<code class="db-kv-code">{database.publicPort}</code>
						<Button
							variant="ghost"
							size="sm"
							class="shrink-0"
							onclick={() => onCopy(String(database.publicPort), 'pubPort')}
							aria-label="Copy port"
						>
							{#if copiedField === 'pubPort'}<Check class="h-3.5 w-3.5" />{:else}<Copy
									class="h-3.5 w-3.5"
								/>{/if}
						</Button>
					</div>

					<span class="db-kv-label">TLS</span>
					<div class="db-kv-value">
						<Badge tone="success">Let's Encrypt · verify-full</Badge>
					</div>
				</div>

				{#if database.publicConnectionString}
					<p class="text-xs font-semibold mt-4 mb-2" style="color: var(--surface-muted);">
						Public connection string
					</p>
					<div class="db-connstr-card">
						<code class="db-connstr-code"
							>{showPublicConnectionString
								? database.publicConnectionString
								: `postgresql://${database.dbUser}:••••••••@${database.publicHostname || database.publicIp}:${database.publicPort}/${database.dbName}?sslmode=verify-full&sslrootcert=system`}</code
						>
						<div class="flex gap-1 shrink-0">
							<Button
								variant="ghost"
								size="sm"
								onclick={() => (showPublicConnectionString = !showPublicConnectionString)}
								aria-label={showPublicConnectionString ? 'Hide' : 'Show'}
							>
								{#if showPublicConnectionString}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye
										class="h-3.5 w-3.5"
									/>{/if}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => onCopy(database.publicConnectionString as string, 'pubConnStr')}
								aria-label="Copy public connection string"
							>
								{#if copiedField === 'pubConnStr'}<Check class="h-3.5 w-3.5" />{:else}<Copy
										class="h-3.5 w-3.5"
									/>{/if}
							</Button>
						</div>
					</div>
				{/if}
			{:else}
				<div class="db-empty-box">
					<p class="text-sm" style="color: var(--surface-muted);">
						Not publicly exposed. Click <strong>Enable</strong> to assign a random free port on your
						organization's shared database IP.
						{#if canManageOrg}
							If no shared IP is configured, set one in
							<a href={`/${orgSlug}/settings`} class="db-link">organization settings</a>.
						{:else}
							If no shared IP is configured, ask an organization admin to set one.
						{/if}
					</p>
				</div>
			{/if}
		</SectionCard>
	{/if}
</div>

<style>
	.dbc-formats {
		display: flex;
		gap: 0.25rem;
		overflow-x: auto;
	}
	.dbc-format {
		padding: 0.25rem 0.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		font-family: var(--font-mono, monospace);
		color: var(--text-muted);
		background: none;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast),
			border-color var(--dur-fast);
	}
	.dbc-format:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}
	.dbc-format--active {
		color: var(--text-default);
		background-color: var(--bg-sunken);
		border-color: color-mix(in srgb, var(--border-default) 80%, transparent);
	}
	.dbc-uri {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.875rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background-color: var(--bg-sunken);
	}
	.dbc-uri-actions {
		display: flex;
		gap: 0.25rem;
		flex-shrink: 0;
	}
	.dbc-eps {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}
	.dbc-ep--idle {
		opacity: 0.55;
	}
	.dbc-ep-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.375rem;
	}
	.dbc-ep-suffix {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		color: var(--text-faint);
	}
	.dbc-ep-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background-color: var(--bg-sunken);
		min-width: 0;
	}
	.dbc-ep-uri {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-footnote);
		color: var(--text-default);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}
	.dbc-ep-note {
		font-size: var(--text-caption);
		color: var(--text-muted);
		margin: 0.375rem 0 0;
	}
	.dbc-dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0 1.5rem;
		margin: 1rem 0 0;
	}
	.dbc-dl-row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		padding: 0.5rem 0;
	}
	.dbc-dl-row:not(:first-child) {
		border-top: 1px solid color-mix(in srgb, var(--border-default) 55%, transparent);
	}
	.dbc-dt {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}
	.dbc-dd {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin: 0;
		min-width: 0;
	}
	.dbc-dd-copy {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		padding: 0.125rem 0.5rem;
		margin-left: -0.5rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.dbc-dd-copy:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}
	.dbc-dd-value {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-family: var(--font-mono, monospace);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dbc-dd-copy :global(.dbc-dd-icon) {
		opacity: 0;
		flex-shrink: 0;
		transition: opacity var(--dur-fast);
	}
	.dbc-dd-copy:hover :global(.dbc-dd-icon) {
		opacity: 0.7;
	}
	.dbc-reveal {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: color var(--dur-fast);
	}
	.dbc-reveal:hover {
		color: var(--text-default);
	}
	.dbc-console-btn:hover {
		opacity: 0.8;
	}
	.dbc-fused {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--bg-surface);
		overflow: hidden;
	}
	.dbc-fused-head {
		display: flex;
		align-items: center;
		padding: var(--space-3);
		border-bottom: 1px solid var(--border-default);
		background-color: var(--bg-surface);
	}
	.dbc-formats--tab {
		display: flex;
		gap: 0;
		background-color: var(--bg-surface);
		padding: 0 0.5rem;
		overflow-x: auto;
	}
	.dbc-formats--tab .dbc-format {
		border: none;
		border-radius: 0;
		border-bottom: 2px solid transparent;
		padding: 0.75rem 0.75rem;
		margin-bottom: -1px;
	}
	.dbc-formats--tab .dbc-format:hover {
		background: none;
	}
	.dbc-formats--tab .dbc-format--active {
		background: none;
		border-bottom-color: var(--accent);
		color: var(--text-default);
	}
	.dbc-fused-body {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 1rem 1.125rem;
		background-color: var(--bg-sunken);
	}
	.dbc-fused-code {
		flex: 1;
		min-width: 0;
		font-size: var(--text-footnote);
		font-family: var(--font-mono, monospace);
		color: var(--text-default);
		word-break: break-all;
		line-height: 1.55;
	}
	.dbc-fused-footer {
		padding: 0.25rem 1.125rem 0.875rem;
		border-top: 1px solid var(--border-default);
	}
</style>
