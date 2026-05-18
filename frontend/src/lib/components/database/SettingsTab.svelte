<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
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
		setParam,
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
		<p class="text-sm font-semibold" style="color: var(--center-channel-color);">PostgreSQL parameters</p>
		{#if database.mode === 'cnpg'}
			<div class="flex gap-2">
				<button class="btn btn-ghost btn-sm" onclick={onFetchSettings} disabled={settingsSaving}>
					<span>Discard</span>
				</button>
				<button class="btn btn-primary btn-sm" onclick={onSaveSettings} disabled={settingsSaving || !settingsDirty}>
					{#if settingsSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					<span>Save</span>
				</button>
			</div>
		{/if}
	</div>

	{#if database.mode !== 'cnpg'}
		<div class="db-empty-box">
			<p class="text-sm" style="color: var(--surface-muted);">Database settings are only configurable for CNPG-backed databases.</p>
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
								<span class="db-status-pill db-status-pill-warn">restart required</span>
							{/if}
						</div>
						<p class="db-setting-help">{p.help} Default: <code class="db-inline-code">{p.defaultValue}</code>.</p>
					</div>
					<div class="db-setting-control">
						{#if p.kind === 'int'}
							<input
								id={`param-${p.key}`}
								type="number"
								min={p.min}
								max={p.max}
								class="input font-mono text-sm"
								value={paramValue(p.key)}
								oninput={(e) => setParam(p.key, (e.currentTarget as HTMLInputElement).value)}
								placeholder={p.defaultValue}
							/>
						{:else if p.kind === 'memory'}
							<input
								id={`param-${p.key}`}
								type="text"
								class="input font-mono text-sm"
								value={paramValue(p.key)}
								oninput={(e) => setParam(p.key, (e.currentTarget as HTMLInputElement).value)}
								placeholder={p.defaultValue}
							/>
						{:else if p.kind === 'string' && p.enum}
							<select
								id={`param-${p.key}`}
								class="input text-sm"
								value={paramValue(p.key)}
								onchange={(e) => setParam(p.key, (e.currentTarget as HTMLSelectElement).value)}
							>
								{#each p.enum as opt}
									<option value={opt}>{opt}</option>
								{/each}
							</select>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
