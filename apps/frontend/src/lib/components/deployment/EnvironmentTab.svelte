<script lang="ts">
	import {
		Plus,
		Loader2,
		Lock,
		LockOpen,
		Link2,
		ChevronDown,
		Database,
		Boxes
	} from 'lucide-svelte';
	import { Eye, EyeOff, Trash2 } from '@jis3r/icons';
	import { slide } from '$lib/utils/transitions';
	import { Alert, Menu, MenuItem, SectionCard } from '$lib/components/ui';
	import { envVarsToRaw, rawToEnvVarsKeepingSecrets } from './deployment-helpers';
	import {
		SEALED_PLACEHOLDER,
		autoSecretForKey,
		type EditableEnvVar
	} from '$lib/utils/env-secrets';
	import {
		PRIMARY_FIELD,
		fieldLabel,
		isResourceRef,
		refFor,
		refLabel,
		refParts,
		suggestedKey,
		type Binding,
		type BindingOption
	} from './bindings';

	let {
		envVars = $bindable<EditableEnvVar[]>(),
		isEditing = $bindable(false),
		savingEnv,
		onSave,
		bindings = [],
		resourceOptions = [],
		onConnect,
		conflicts = []
	}: {
		envVars: EditableEnvVar[];
		isEditing?: boolean;
		savingEnv: boolean;
		onSave: () => void;
		bindings?: Binding[];
		resourceOptions?: BindingOption[];
		onConnect?: (option: BindingOption) => Promise<Binding | null>;
		conflicts?: { key: string; reason: string }[];
	} = $props();

	const CONFLICT_REASONS: Record<string, string> = {
		reference: 'was changed in Kubernetes, but its value comes from a reference. Edit it here.',
		'foreign-source': 'is read from a ConfigMap or Secret Orchard does not manage.',
		'orphan-secret-ref': 'points at a secret Orchard has no variable for.',
		'removed-secret':
			'is a secret that was removed in Kubernetes. Orchard kept its value; delete it here if that was intended.',
		'mass-removal':
			'disappeared from Kubernetes along with most other variables. Orchard kept it; delete it here if that was intended.'
	};

	type Pick = { kind: 'bound'; binding: Binding } | { kind: 'option'; option: BindingOption };

	const picks = $derived<Pick[]>([
		...bindings.map((binding) => ({ kind: 'bound' as const, binding })),
		...resourceOptions.map((option) => ({ kind: 'option' as const, option }))
	]);
	const databasePicks = $derived(picks.filter((p) => pickType(p) === 'database'));
	const appPicks = $derived(picks.filter((p) => pickType(p) === 'deployment'));
	let connecting = $state(false);

	function pickType(p: Pick) {
		return p.kind === 'bound' ? p.binding.resourceType : p.option.resourceType;
	}
	function pickName(p: Pick) {
		return p.kind === 'bound' ? (p.binding.resource?.name ?? p.binding.name) : p.option.name;
	}
	function pickEndpoint(p: Pick) {
		return p.kind === 'bound' ? p.binding.endpoint : p.option.endpoint;
	}

	async function resolvePick(p: Pick): Promise<Binding | null> {
		if (p.kind === 'bound') return p.binding;
		if (!onConnect) return null;
		connecting = true;
		try {
			return await onConnect(p.option);
		} finally {
			connecting = false;
		}
	}

	async function useResource(index: number, p: Pick) {
		const binding = await resolvePick(p);
		if (!binding) return;
		const value = refFor(binding.name, PRIMARY_FIELD[binding.resourceType]);
		const taken = envVars.map((e) => e.key.trim()).filter(Boolean);
		isEditing = true;
		envVars = envVars.map((e, i) =>
			i === index
				? {
						...e,
						key: e.key.trim() || suggestedKey(binding, PRIMARY_FIELD[binding.resourceType], taken),
						value,
						secret: Boolean(e.sealed),
						secretTouched: true
					}
				: e
		);
	}

	function toggleSecret(index: number) {
		if (envVars[index]?.sealed) return;
		isEditing = true;
		envVars = envVars.map((e, i) =>
			i === index ? { ...e, secret: !e.secret, secretTouched: true } : e
		);
	}

	function setKey(index: number, key: string) {
		isEditing = true;
		envVars = envVars.map((e, i) => (i === index ? autoSecretForKey({ ...e, key }) : e));
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
			const parsed = rawToEnvVarsKeepingSecrets(envRawText, envVars);
			envVars = [...parsed, { key: '', value: '' }];
		}
		envViewMode = mode;
	}

	function setValue(index: number, value: string) {
		isEditing = true;
		envVars = envVars.map((e, i) =>
			i === index ? { ...e, value, secret: Boolean(e.sealed), secretTouched: true } : e
		);
	}

	function handleSave() {
		if (envViewMode === 'raw') {
			const parsed = rawToEnvVarsKeepingSecrets(envRawText, envVars);
			envVars = [...parsed, { key: '', value: '' }];
		}
		isEditing = false;
		onSave();
	}
</script>

{#snippet resourceMenu(onPick: (p: Pick) => void)}
	{#if databasePicks.length > 0}
		<div class="env-menu-label">Databases</div>
		{#each databasePicks as p (p.kind === 'bound' ? p.binding.id : p.option.resourceId)}
			<MenuItem onclick={() => onPick(p)}>
				<Database size={14} />
				<span class="env-pick">
					<span>{pickName(p)}</span>
					{#if pickEndpoint(p)}<span class="env-pick-sub">{pickEndpoint(p)}</span>{/if}
				</span>
			</MenuItem>
		{/each}
	{/if}
	{#if appPicks.length > 0}
		<div class="env-menu-label">Apps on this project</div>
		{#each appPicks as p (p.kind === 'bound' ? p.binding.id : p.option.resourceId)}
			<MenuItem onclick={() => onPick(p)}>
				<Boxes size={14} />
				<span class="env-pick">
					<span>{pickName(p)}</span>
					<span class="env-pick-sub">{pickEndpoint(p) ?? 'No port exposed yet'}</span>
				</span>
			</MenuItem>
		{/each}
	{/if}
{/snippet}

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
	{#if conflicts.length > 0}
		<div class="env-conflicts">
			<Alert tone="warning" title="Changed outside Orchard">
				<ul class="env-conflict-list">
					{#each conflicts as conflict (conflict.key)}
						<li>
							<code>{conflict.key}</code>
							{CONFLICT_REASONS[conflict.reason] ?? 'differs from the running app.'}
						</li>
					{/each}
				</ul>
			</Alert>
		</div>
	{/if}
	<div class="env-container">
		{#if envViewMode === 'ui'}
			{#each envVars as env, index (index)}
				{@const isRevealed = revealedIndices.has(index)}
				{@const hasKey = env.key.trim().length > 0}
				{@const withheld = Boolean(env.sealed) && env.value === ''}
				{@const masked = Boolean(env.secret) && !isRevealed}
				{@const isRef = isResourceRef(env.value)}
				{@const refText = isRef ? refLabel(env.value, bindings) : null}
				{@const bound = isRef
					? bindings.find((b) => b.name === refParts(env.value)?.binding)
					: null}
				<div class="env-row" transition:slide={{ duration: 150 }}>
					<div class="env-row-inner">
						<div class="env-key-col">
							<input
								type="text"
								value={env.key}
								oninput={(e) => setKey(index, e.currentTarget.value)}
								placeholder="KEY"
								class="env-key-input"
								onfocus={() => (isEditing = true)}
							/>
						</div>
						<div class="env-val-col">
							{#if isRef}
								<Menu placement="bottom-start">
									{#snippet trigger(props)}
										<button {...props} type="button" class="env-token" title={env.value}>
											<Link2 size={13} />
											<span class="env-token-text">{refText}</span>
											<ChevronDown size={12} class="env-token-chevron" />
										</button>
									{/snippet}
									{#if bound}
										<div class="env-menu-label">Read from {bound.resource?.name ?? bound.name}</div>
										{#each bound.fields as field (field)}
											<MenuItem onclick={() => setValue(index, refFor(bound.name, field))}>
												<span>{fieldLabel(field)}</span>
											</MenuItem>
										{/each}
									{/if}
									<MenuItem onclick={() => setValue(index, '')}>
										<span>Type a value instead</span>
									</MenuItem>
								</Menu>
							{:else}
								<input
									type={masked || withheld ? 'password' : 'text'}
									bind:value={env.value}
									placeholder={withheld ? 'Sealed, type to replace' : hasKey ? 'value' : ''}
									class="env-val-input"
									class:env-val-sealed={withheld}
									onfocus={() => (isEditing = true)}
								/>
								{#if env.value === '' && !withheld && picks.length > 0}
									<Menu placement="bottom-end">
										{#snippet trigger(props)}
											<button {...props} type="button" class="env-use" disabled={connecting}>
												<Link2 size={12} />
												<span>Use a resource</span>
											</button>
										{/snippet}
										{@render resourceMenu((p) => useResource(index, p))}
									</Menu>
								{/if}
							{/if}
						</div>
						<div class="env-actions">
							{#if env.secret && !withheld && !isRef && env.value !== ''}
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
							{/if}
							<button
								type="button"
								onclick={() => toggleSecret(index)}
								class="env-action-btn"
								class:env-action-secret={env.secret}
								class:env-action-sealed={env.sealed}
								aria-disabled={env.sealed}
								aria-label={env.sealed
									? 'Sealed. Delete and re-add the variable to make it visible'
									: env.secret
										? 'Secret, sealed on save'
										: 'Mark as secret'}
								title={env.sealed
									? 'Sealed. Delete and re-add the variable to make it visible'
									: env.secret
										? 'Secret, sealed on save'
										: 'Mark as secret'}
							>
								{#if env.secret}<Lock size={14} class="h-3.5 w-3.5" />{:else}<LockOpen
										size={14}
										class="h-3.5 w-3.5"
									/>{/if}
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
				onfocus={() => (isEditing = true)}></textarea>
			{#if envVars.some((e) => e.secret && e.key.trim())}
				<p class="env-secret-note">
					<Lock size={12} />
					<span>
						Secret values show as <code>{SEALED_PLACEHOLDER}</code>. Replace one to set a new value;
						it stays sealed.
					</span>
				</p>
			{/if}
		{/if}
	</div>
	{#if envViewMode === 'ui' && envVars.some((e) => e.secret && e.key.trim())}
		<p class="env-secret-note">
			<Lock size={12} />
			<span>
				Secret values are sealed: write-only, encrypted at rest, and never shown again. Enter a new
				value to replace one.
			</span>
		</p>
	{/if}
	<div class="env-footer">
		<p class="env-footer-hint">Saving restarts pods.</p>
		<button onclick={handleSave} disabled={savingEnv || !isEditing} class="btn btn-primary">
			{#if savingEnv}<Loader2 class="h-4 w-4 animate-spin" />{/if}
			<span>Save</span>
		</button>
	</div>
</SectionCard>

<style>
	.env-conflicts {
		margin-bottom: 0.75rem;
	}
	.env-conflict-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.env-conflict-list code {
		font-family: var(--font-mono);
		font-weight: 600;
	}
	.env-val-col {
		position: relative;
		display: flex;
		align-items: center;
	}
	.env-token {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 100%;
		padding: 0.25rem 0.5rem 0.25rem 0.5rem;
		border: 0;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--accent);
		font-size: var(--text-caption);
		font-weight: 600;
		cursor: pointer;
	}
	.env-token:hover {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}
	.env-token-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.env-use {
		position: absolute;
		right: 0.5rem;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem;
		border: 0;
		border-radius: var(--radius-pill);
		background: none;
		color: var(--text-faint);
		font-size: var(--text-caption);
		cursor: pointer;
	}
	.env-use:hover {
		background: var(--fill-quiet);
		color: var(--text-muted);
	}
	.env-pick {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.env-pick-sub {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		color: var(--text-faint);
	}
	.env-menu-label {
		padding: 0.375rem 0.75rem 0.125rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.env-action-secret {
		color: var(--status-warning);
		background: color-mix(in srgb, var(--status-warning) 12%, transparent);
	}
	.env-action-sealed {
		cursor: default;
	}
	.env-val-sealed::placeholder {
		font-style: italic;
	}
	.env-secret-note {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		margin-top: 0.75rem;
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}
	.env-secret-note :global(svg) {
		flex-shrink: 0;
		margin-top: 0.1rem;
	}
	.env-secret-note code {
		font-family: var(--font-mono);
	}
</style>
