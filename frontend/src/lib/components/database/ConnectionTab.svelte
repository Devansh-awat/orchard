<script lang="ts">
	import { Loader2, Copy, Check, Eye, EyeOff } from 'lucide-svelte';
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
</script>

<div class="space-y-5">
	<div class="card rounded-2xl p-5">
		<p class="text-sm font-semibold mb-4" style="color: var(--center-channel-color);">
			Connection details
		</p>
		<div class="db-kv-grid">
			<span class="db-kv-label">Host (internal)</span>
			<div class="db-kv-value">
				<code class="db-kv-code">{database.host}</code>
				<button
					class="btn btn-ghost btn-sm shrink-0"
					onclick={() => onCopy(database.host, 'host')}
					aria-label="Copy host"
				>
					{#if copiedField === 'host'}<Check class="h-3.5 w-3.5" />{:else}<Copy
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
			</div>

			<span class="db-kv-label">Port</span>
			<div class="db-kv-value">
				<code class="db-kv-code">{database.port}</code>
				<button
					class="btn btn-ghost btn-sm shrink-0"
					onclick={() => onCopy(String(database.port), 'port')}
					aria-label="Copy port"
				>
					{#if copiedField === 'port'}<Check class="h-3.5 w-3.5" />{:else}<Copy
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
			</div>

			<span class="db-kv-label">Database</span>
			<div class="db-kv-value">
				<code class="db-kv-code">{database.dbName}</code>
				<button
					class="btn btn-ghost btn-sm shrink-0"
					onclick={() => onCopy(database.dbName, 'dbName')}
					aria-label="Copy database"
				>
					{#if copiedField === 'dbName'}<Check class="h-3.5 w-3.5" />{:else}<Copy
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
			</div>

			<span class="db-kv-label">Username</span>
			<div class="db-kv-value">
				<code class="db-kv-code">{database.dbUser}</code>
				<button
					class="btn btn-ghost btn-sm shrink-0"
					onclick={() => onCopy(database.dbUser, 'user')}
					aria-label="Copy username"
				>
					{#if copiedField === 'user'}<Check class="h-3.5 w-3.5" />{:else}<Copy
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
			</div>

			<span class="db-kv-label">Password</span>
			<div class="db-kv-value">
				<code class="db-kv-code">{showPassword ? database.dbPassword : '••••••••••••'}</code>
				<button
					class="btn btn-ghost btn-sm shrink-0"
					onclick={() => (showPassword = !showPassword)}
					aria-label={showPassword ? 'Hide' : 'Show'}
				>
					{#if showPassword}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
				</button>
				<button
					class="btn btn-ghost btn-sm shrink-0"
					onclick={() => onCopy(database.dbPassword, 'password')}
					aria-label="Copy password"
				>
					{#if copiedField === 'password'}<Check class="h-3.5 w-3.5" />{:else}<Copy
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
			</div>
		</div>
	</div>

	<div class="card rounded-2xl p-5">
		<p class="text-sm font-semibold mb-3" style="color: var(--center-channel-color);">
			Connection string
		</p>
		<div class="db-connstr-card">
			<code class="db-connstr-code"
				>{showConnectionString
					? database.connectionString
					: `postgresql://${database.dbUser}:••••••••@${database.host}:${database.port}/${database.dbName}`}</code
			>
			<div class="flex gap-1 shrink-0">
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => (showConnectionString = !showConnectionString)}
					aria-label={showConnectionString ? 'Hide' : 'Show'}
				>
					{#if showConnectionString}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => onCopy(database.connectionString, 'connstr')}
					aria-label="Copy connection string"
				>
					{#if copiedField === 'connstr'}<Check class="h-3.5 w-3.5" />{:else}<Copy
							class="h-3.5 w-3.5"
						/>{/if}
				</button>
			</div>
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
					<button
						class="btn btn-secondary btn-sm"
						onclick={onDisablePublic}
						disabled={togglingPublic}
					>
						{#if togglingPublic}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						<span>Disable</span>
					</button>
				{:else}
					<button class="btn btn-primary btn-sm" onclick={onEnablePublic} disabled={togglingPublic}>
						{#if togglingPublic}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						<span>Enable</span>
					</button>
				{/if}
			</div>

			{#if database.publicEnabled && database.publicIp && database.publicPort}
				<div class="db-kv-grid">
					<span class="db-kv-label">Public host</span>
					<div class="db-kv-value">
						<code class="db-kv-code">{database.publicHostname || database.publicIp}</code>
						<button
							class="btn btn-ghost btn-sm shrink-0"
							onclick={() =>
								onCopy((database.publicHostname || database.publicIp) as string, 'pubHost')}
							aria-label="Copy host"
						>
							{#if copiedField === 'pubHost'}<Check class="h-3.5 w-3.5" />{:else}<Copy
									class="h-3.5 w-3.5"
								/>{/if}
						</button>
					</div>

					<span class="db-kv-label">Public port</span>
					<div class="db-kv-value">
						<code class="db-kv-code">{database.publicPort}</code>
						<button
							class="btn btn-ghost btn-sm shrink-0"
							onclick={() => onCopy(String(database.publicPort), 'pubPort')}
							aria-label="Copy port"
						>
							{#if copiedField === 'pubPort'}<Check class="h-3.5 w-3.5" />{:else}<Copy
									class="h-3.5 w-3.5"
								/>{/if}
						</button>
					</div>

					<span class="db-kv-label">TLS</span>
					<div class="db-kv-value">
						<span class="db-status-pill db-status-pill-completed">Let's Encrypt · verify-full</span>
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
							<button
								class="btn btn-ghost btn-sm"
								onclick={() => (showPublicConnectionString = !showPublicConnectionString)}
								aria-label={showPublicConnectionString ? 'Hide' : 'Show'}
							>
								{#if showPublicConnectionString}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye
										class="h-3.5 w-3.5"
									/>{/if}
							</button>
							<button
								class="btn btn-ghost btn-sm"
								onclick={() => onCopy(database.publicConnectionString as string, 'pubConnStr')}
								aria-label="Copy public connection string"
							>
								{#if copiedField === 'pubConnStr'}<Check class="h-3.5 w-3.5" />{:else}<Copy
										class="h-3.5 w-3.5"
									/>{/if}
							</button>
						</div>
					</div>
				{/if}
			{:else}
				<div class="db-empty-box">
					<p class="text-sm" style="color: var(--surface-muted);">
						Not publicly exposed. Click <strong>Enable</strong> to assign a random free port on your
						organization's shared database IP. If no shared IP is configured, set one in
						<a href={`/${orgSlug}/settings`} class="db-link">organization settings</a>.
					</p>
				</div>
			{/if}
		</div>
	{/if}
</div>
