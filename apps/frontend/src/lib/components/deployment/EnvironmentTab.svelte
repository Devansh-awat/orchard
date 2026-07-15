<script lang="ts">
	import { Plus, Loader2, Lock, LockOpen } from 'lucide-svelte';
	import { Eye, EyeOff, Trash2 } from '@jis3r/icons';
	import { slide } from '$lib/utils/transitions';
	import { SectionCard } from '$lib/components/ui';
	import { envVarsToRaw, rawToEnvVars } from '$lib/utils/format';

	let {
		envVars = $bindable<Array<{ key: string; value: string; secret?: boolean }>>(),
		isEditing = $bindable(false),
		savingEnv,
		onSave
	}: {
		envVars: Array<{ key: string; value: string; secret?: boolean }>;
		isEditing?: boolean;
		savingEnv: boolean;
		onSave: () => void;
	} = $props();

	function toggleSecret(index: number) {
		isEditing = true;
		envVars = envVars.map((e, i) => (i === index ? { ...e, secret: !e.secret } : e));
	}

	let envViewMode = $state<'ui' | 'raw'>('ui');
	let envRawText = $state('');
	let revealedIndices = $state<Set<number>>(new Set());

	function toggleReveal(index: number) {
		revealedIndices = new Set(revealedIndices);
		if (revealedIndices.has(index)) {
			revealedIndices.delete(index);
		} else {
			revealedIndices.add(index);
		}
	}

	function addEnvRow() {
		isEditing = true;
		envVars = [...envVars, { key: '', value: '' }];
	}

	function removeEnvRow(index: number) {
		isEditing = true;
		envVars = envVars.filter((_, i) => i !== index);
	}

	function switchEnvView(mode: 'ui' | 'raw') {
		if (mode === envViewMode) return;
		isEditing = true;
		if (mode === 'raw') {
			envRawText = envVarsToRaw(envVars);
		} else {
			const parsed = rawToEnvVars(envRawText);
			envVars = [...parsed, { key: '', value: '' }];
		}
		envViewMode = mode;
	}

	function handleSave() {
		if (envViewMode === 'raw') {
			const parsed = rawToEnvVars(envRawText);
			envVars = [...parsed, { key: '', value: '' }];
		}
		isEditing = false;
		onSave();
	}
</script>

<SectionCard title="Environment variables">
	{#snippet actions()}
		<div class="relative flex rounded-lg p-0.5" style="background-color: var(--control-bg);">
			<div
				class="absolute top-0.5 bottom-0.5 rounded-md shadow-sm transition-all duration-200 ease-in-out"
				style="background-color: var(--surface-bg); width: calc(50% - 2px); left: {envViewMode ===
				'ui'
					? '2px'
					: 'calc(50% + 0px)'};"
			></div>
			<button
				onclick={() => switchEnvView('ui')}
				class="relative z-10 px-3 py-1 text-xs font-medium rounded-md transition-colors duration-200"
				style="color: {envViewMode === 'ui'
					? 'var(--center-channel-color)'
					: 'var(--surface-muted)'};">UI</button
			>
			<button
				onclick={() => switchEnvView('raw')}
				class="relative z-10 px-3 py-1 text-xs font-medium rounded-md transition-colors duration-200"
				style="color: {envViewMode === 'raw'
					? 'var(--center-channel-color)'
					: 'var(--surface-muted)'};">Raw</button
			>
		</div>
	{/snippet}
	<div class="env-container">
		{#if envViewMode === 'ui'}
			{#each envVars as env, index (index)}
				{@const isRevealed = revealedIndices.has(index)}
				{@const hasKey = env.key.trim().length > 0}
				<div class="env-row" transition:slide={{ duration: 150 }}>
					<div class="env-row-inner">
						<div class="env-key-col">
							<input
								type="text"
								bind:value={env.key}
								placeholder="KEY"
								class="env-key-input"
								onfocus={() => (isEditing = true)}
							/>
						</div>
						<div class="env-val-col">
							<input
								type={isRevealed ? 'text' : 'password'}
								bind:value={env.value}
								placeholder={hasKey ? 'value' : ''}
								class="env-val-input"
								onfocus={() => (isEditing = true)}
							/>
						</div>
						<div class="env-actions">
							<button
								type="button"
								onclick={() => toggleReveal(index)}
								class="env-action-btn"
								aria-label={isRevealed ? 'Hide' : 'Show'}
							>
								{#if isRevealed}<EyeOff size={14} class="h-3.5 w-3.5" />{:else}<Eye
										size={14}
										class="h-3.5 w-3.5"
									/>{/if}
							</button>
							<button
								type="button"
								onclick={() => toggleSecret(index)}
								class="env-action-btn"
								class:env-action-secret={env.secret}
								aria-label={env.secret ? 'Secret (stored in a Kubernetes Secret)' : 'Mark as secret'}
								title={env.secret ? 'Secret — stored in a Kubernetes Secret' : 'Mark as secret'}
							>
								{#if env.secret}<Lock size={14} class="h-3.5 w-3.5" />{:else}<LockOpen size={14} class="h-3.5 w-3.5" />{/if}
							</button>
							<button
								onclick={() => removeEnvRow(index)}
								class="env-action-btn env-action-delete"
								aria-label="Remove"
							>
								<Trash2 size={14} class="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				</div>
			{/each}
			<button onclick={addEnvRow} class="env-add-btn">
				<Plus class="h-4 w-4" />
				<span>Add variable</span>
			</button>
		{:else}
			<textarea
				bind:value={envRawText}
				placeholder="KEY1=value1&#10;KEY2=value2&#10;# Comments are ignored"
				class="env-raw-textarea"
				onfocus={() => (isEditing = true)}
			></textarea>
		{/if}
	</div>
	<div class="env-footer">
		<p class="env-footer-hint">Saving restarts pods.</p>
		<button onclick={handleSave} disabled={savingEnv || !isEditing} class="btn btn-primary">
			{#if savingEnv}<Loader2 class="h-4 w-4 animate-spin" />{/if}
			<span>Save</span>
		</button>
	</div>
</SectionCard>

<style>
	.env-action-secret {
		color: #d97706;
		background: color-mix(in srgb, #f59e0b 12%, transparent);
	}
</style>
