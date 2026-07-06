<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { Button, Input, Select, Badge } from '$lib/components/ui';
	import type { DatabaseDetail, ParamMeta } from './types';

	let {
		database,
		paramSchema,
		settingsLoading,
		settingsLoaded,
		settingsSaving,
		settingsDirty,
		onFetchSettings,
		onSaveSettings,
		paramValue,
		setParam
	}: {
		database: DatabaseDetail;
		paramSchema: ParamMeta[];
		settingsLoading: boolean;
		settingsLoaded: boolean;
		settingsSaving: boolean;
		settingsDirty: boolean;
		onFetchSettings: () => void;
		onSaveSettings: () => void;
		paramValue: (key: string) => string;
		setParam: (key: string, v: string) => void;
	} = $props();
</script>

<div class="card rounded-2xl p-5">
	<div class="flex items-center justify-between mb-4">
		<p class="text-sm font-semibold" style="color: var(--center-channel-color);">
			PostgreSQL parameters
		</p>
		{#if database.mode === 'cnpg'}
			<div class="flex gap-2">
				<Button variant="ghost" size="sm" onclick={onFetchSettings} disabled={settingsSaving}>
					Discard
				</Button>
				<Button
					variant="primary"
					size="sm"
					onclick={onSaveSettings}
					loading={settingsSaving}
					disabled={!settingsDirty}
				>
					Save
				</Button>
			</div>
		{/if}
	</div>

	{#if database.mode !== 'cnpg'}
		<div class="db-empty-box">
			<p class="text-sm" style="color: var(--surface-muted);">
				Database settings are only configurable for CNPG-backed databases.
			</p>
		</div>
	{:else if settingsLoading && !settingsLoaded}
		<div class="db-empty-box flex items-center gap-2">
			<Loader2 class="h-4 w-4 animate-spin" />
			<span class="text-sm" style="color: var(--surface-muted);">Loading settings…</span>
		</div>
	{:else}
		<div class="space-y-4">
			{#each paramSchema as p (p.key)}
				<div class="db-setting-row">
					<div class="db-setting-info">
						<div class="flex items-center gap-2 flex-wrap">
							<label for={`param-${p.key}`} class="db-setting-label">{p.label}</label>
							<code class="db-inline-code">{p.key}</code>
							{#if p.requiresRestart}
								<Badge tone="warning">Restart required</Badge>
							{/if}
						</div>
						<p class="db-setting-help">
							{p.help} Default: <code class="db-inline-code">{p.defaultValue}</code>.
						</p>
					</div>
					<div class="db-setting-control">
						{#if p.kind === 'int'}
							<Input
								id={`param-${p.key}`}
								type="number"
								min={p.min}
								max={p.max}
								class="font-mono text-sm"
								value={paramValue(p.key)}
								oninput={(e: Event) => setParam(p.key, (e.currentTarget as HTMLInputElement).value)}
								placeholder={p.defaultValue}
							/>
						{:else if p.kind === 'memory'}
							<Input
								id={`param-${p.key}`}
								type="text"
								class="font-mono text-sm"
								value={paramValue(p.key)}
								oninput={(e: Event) => setParam(p.key, (e.currentTarget as HTMLInputElement).value)}
								placeholder={p.defaultValue}
							/>
						{:else if p.kind === 'string' && p.enum}
							<Select
								id={`param-${p.key}`}
								class="text-sm"
								value={paramValue(p.key)}
								onchange={(e: Event) =>
									setParam(p.key, (e.currentTarget as HTMLSelectElement).value)}
							>
								{#each p.enum as opt (opt)}
									<option value={opt}>{opt}</option>
								{/each}
							</Select>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
