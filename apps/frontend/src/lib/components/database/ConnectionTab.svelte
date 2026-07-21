<script lang="ts">
	import { Copy, Check, Eye, EyeOff } from 'lucide-svelte';
	import { selectedOrganization } from '$lib/stores';
	import { Button, Badge } from '$lib/components/ui';
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
	<div class="dbc-formats dbc-formats--tab" role="tablist" aria-label="Connection format">
		{#each FORMATS as f (f.id)}
			<button
				type="button"
				class="dbc-format"
				class:dbc-format--active={connFormat === f.id}
				aria-selected={connFormat === f.id}
				role="tab"
				onclick={() => (connFormat = f.id)}
			>
				{f.label}
			</button>
		{/each}
	</div>
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
		{@render formatChips()}
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

	{#if database.mode === 'cnpg'}
		<div class="card rounded-2xl p-5">
			<div class="flex items-center justify-between mb-3 flex-wrap gap-2">
				<div>
					<p class="text-sm font-semibold" style="color: var(--center-channel-color);">
						Public access
					</p>
					<p class="text-xs mt-1" style="color: var(--surface-muted);">
						Expose this database on a shared organization IP with a unique port.
					</p>
				</div>
				{#if database.publicEnabled}
					<Button variant="secondary" size="sm" onclick={onDisablePublic} loading={togglingPublic}>
						Disable
					</Button>
				{:else}
					<Button variant="primary" size="sm" onclick={onEnablePublic} loading={togglingPublic}>
						Enable
					</Button>
				{/if}
			</div>

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
		</div>
	{/if}
</div>

<style>
	.dbc-formats {
		display: flex;
		gap: 0.25rem;
		overflow-x: auto;
	}
	.dbc-format {
		padding: 0.25rem 0.625rem;
		font-size: 0.75rem;
		font-weight: 500;
		font-family: var(--font-mono, monospace);
		color: var(--text-muted);
		background: none;
		border: 1px solid transparent;
		border-radius: 0.5rem;
		cursor: pointer;
		white-space: nowrap;
		transition:
			color 120ms,
			background-color 120ms,
			border-color 120ms;
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
		border-radius: 0.75rem;
		background-color: var(--bg-sunken);
	}
	.dbc-uri-actions {
		display: flex;
		gap: 0.25rem;
		flex-shrink: 0;
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
		padding: 0.4375rem 0;
	}
	.dbc-dl-row:not(:first-child) {
		border-top: 1px solid color-mix(in srgb, var(--border-default) 55%, transparent);
	}
	.dbc-dt {
		font-size: 0.8125rem;
		font-weight: 550;
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
		gap: 0.375rem;
		min-width: 0;
		padding: 0.125rem 0.375rem;
		margin-left: -0.375rem;
		border: none;
		border-radius: 0.375rem;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color 120ms,
			background-color 120ms;
	}
	.dbc-dd-copy:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}
	.dbc-dd-value {
		font-size: 0.8125rem;
		font-family: var(--font-mono, monospace);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dbc-dd-copy :global(.dbc-dd-icon) {
		opacity: 0;
		flex-shrink: 0;
		transition: opacity 120ms;
	}
	.dbc-dd-copy:hover :global(.dbc-dd-icon) {
		opacity: 0.7;
	}
	.dbc-reveal {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem;
		border: none;
		border-radius: 0.375rem;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: color 120ms;
	}
	.dbc-reveal:hover {
		color: var(--text-default);
	}
	.dbc-console-btn:hover {
		opacity: 0.8;
	}
	.dbc-fused {
		border: 1px solid var(--border-default);
		border-radius: 1rem;
		background-color: var(--bg-surface);
		overflow: hidden;
	}
	.dbc-formats--tab {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--border-default);
		background-color: var(--bg-surface);
		padding: 0 0.5rem;
		overflow-x: auto;
	}
	.dbc-formats--tab .dbc-format {
		border: none;
		border-radius: 0;
		border-bottom: 2px solid transparent;
		padding: 0.625rem 0.75rem;
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
		font-size: 0.8125rem;
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
