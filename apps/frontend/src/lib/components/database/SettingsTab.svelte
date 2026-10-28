<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import {
		Button,
		Input,
		Dropdown,
		Badge,
		SectionCard,
		EmptyState,
		Alert
	} from '$lib/components/ui';
	import type { DatabaseDetail, ParamMeta } from './types';

	let {
		database,
		paramSchema,
		settingsLoading,
		settingsLoaded,
		settingsSaving,
		settingsDirty,
		settingsAdvisories = [],
		settingsDrift = {},
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
		settingsAdvisories?: { key: string; message: string }[];
		settingsDrift?: Record<string, string | null>;
		onFetchSettings: () => void;
		onSaveSettings: () => void;
		paramValue: (key: string) => string;
		setParam: (key: string, v: string) => void;
	} = $props();

	const advisoryFor = (key: string) => settingsAdvisories.find((a) => a.key === key);
</script>

<SectionCard title="PostgreSQL parameters">
	{#snippet actions()}
		{#if database.mode === 'cnpg'}
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
		{/if}
	{/snippet}

	{#if database.mode !== 'cnpg'}
		<EmptyState
			title="Settings need a dedicated database"
			description="PostgreSQL parameters are only configurable for CNPG-backed databases."
		/>
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
							{p.help}
							{#if p.autoSized}
								Leave it empty to size it from the memory limit automatically.
							{:else}
								Default: <code class="db-inline-code">{p.defaultValue}</code>.
							{/if}
						</p>
						{#if p.key in settingsDrift}
							<p class="db-setting-drift">
								{#if settingsDrift[p.key] == null}
									The cluster isn't running this value. It was removed outside Orchard.
								{:else}
									The cluster is running <code class="db-inline-code">{settingsDrift[p.key]}</code>,
									set outside Orchard.
								{/if}
							</p>
						{/if}
						{#if advisoryFor(p.key)}
							<div class="db-setting-advisory">
								<Alert tone="warning">{advisoryFor(p.key)?.message}</Alert>
							</div>
						{/if}
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
								placeholder={p.autoSized ? 'Automatic' : p.defaultValue}
							/>
						{:else if p.kind === 'string' && p.enum}
							<Dropdown
								id={`param-${p.key}`}
								value={paramValue(p.key)}
								options={p.enum.map((opt) => ({ value: opt, label: opt }))}
								onchange={(v) => setParam(p.key, v)}
							/>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</SectionCard>

<style>
	.db-setting-drift {
		margin: 0.375rem 0 0;
		font-size: var(--text-caption);
		color: var(--status-warning);
	}
	.db-setting-advisory {
		margin-top: 0.5rem;
		max-width: 46ch;
	}
</style>
