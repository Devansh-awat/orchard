<script lang="ts">
	import { Eye, EyeOff, Lock, LockOpen, Trash2, Plus } from 'lucide-svelte';
	import { autoSecretForKey, mergeParsedEnv, parseEnvLines } from '$lib/utils/env-secrets';

	export interface GridRow {
		key: string;
		value: string;
		secret: boolean;
		sealed?: boolean;
		secretTouched?: boolean;
	}

	let {
		rows = $bindable([] as GridRow[])
	}: {
		rows?: GridRow[];
	} = $props();

	let revealed = $state<Set<number>>(new Set());

	function toggleReveal(i: number) {
		const next = new Set(revealed);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		revealed = next;
	}

	function addRow() {
		rows = [...rows, { key: '', value: '', secret: false }];
	}

	function removeRow(i: number) {
		rows = rows.filter((_, idx) => idx !== i);
	}

	function setKey(i: number, key: string) {
		rows = rows.map((r, idx) => (idx === i ? autoSecretForKey({ ...r, key }) : r));
	}

	function toggleSecret(i: number) {
		if (rows[i]?.sealed) return;
		rows = rows.map((r, idx) => (idx === i ? { ...r, secret: !r.secret, secretTouched: true } : r));
	}

	function onPaste(e: ClipboardEvent, i: number) {
		const text = e.clipboardData?.getData('text') ?? '';
		if (!text.includes('\n') && !text.includes('=')) return;
		const parsed = parseEnvLines(text);
		if (parsed.length === 0) return;
		e.preventDefault();
		const pastedKeys = new Set(parsed.map((p) => p.key));
		const merged = mergeParsedEnv(parsed, rows).map((r) => ({ ...r, secret: Boolean(r.secret) }));
		const next = rows.filter((r, idx) => idx !== i && !pastedKeys.has(r.key.trim()));
		next.splice(Math.min(i, next.length), 0, ...merged);
		rows = next;
	}
</script>

<div class="envgrid">
	{#each rows as row, i (i)}
		{@const withheld = Boolean(row.sealed) && row.value === ''}
		<div class="envgrid-row">
			<div class="envgrid-key-col">
				<input
					class="envgrid-input envgrid-key"
					placeholder="KEY"
					value={row.key}
					oninput={(e) => setKey(i, e.currentTarget.value)}
					onpaste={(e) => onPaste(e, i)}
				/>
			</div>
			<div class="envgrid-val-col">
				<input
					class="envgrid-input envgrid-val"
					class:envgrid-val--sealed={withheld}
					type={row.secret && !revealed.has(i) ? 'password' : 'text'}
					placeholder={withheld ? 'Sealed, type to replace' : 'value'}
					bind:value={row.value}
				/>
			</div>
			<div class="envgrid-actions">
				{#if row.secret && !withheld && row.value !== ''}
					<button
						type="button"
						class="envgrid-action"
						aria-label={revealed.has(i) ? 'Hide' : 'Show'}
						onclick={() => toggleReveal(i)}
					>
						{#if revealed.has(i)}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
					</button>
				{/if}
				<button
					type="button"
					class="envgrid-action"
					class:envgrid-action--secret={row.secret}
					class:envgrid-action--sealed={row.sealed}
					aria-disabled={row.sealed}
					aria-label={row.sealed
						? 'Sealed. Delete and re-add the variable to make it visible'
						: row.secret
							? 'Secret, sealed on save'
							: 'Mark as secret'}
					title={row.sealed
						? 'Sealed. Delete and re-add the variable to make it visible'
						: row.secret
							? 'Secret, sealed on save'
							: 'Mark as secret'}
					onclick={() => toggleSecret(i)}
				>
					{#if row.secret}<Lock size={14} />{:else}<LockOpen size={14} />{/if}
				</button>
				<button
					type="button"
					class="envgrid-action envgrid-action--delete"
					aria-label="Remove"
					onclick={() => removeRow(i)}
				>
					<Trash2 size={14} />
				</button>
			</div>
		</div>
	{/each}
	<button type="button" class="envgrid-add" onclick={addRow}>
		<Plus size={16} />
		Add variable
	</button>
</div>

<style>
	/* Mirrors the deployment page's environment-variable editor: a solid,
	   bordered table of borderless inputs rather than separate input boxes. */
	.envgrid {
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-md);
		overflow: hidden;
		background-color: var(--surface-bg);
	}
	.envgrid-row {
		display: flex;
		align-items: center;
		min-height: 2.75rem;
		border-bottom: 1px solid var(--surface-border);
		transition: background-color var(--dur-fast);
	}
	.envgrid-row:hover,
	.envgrid-row:focus-within {
		background-color: color-mix(in srgb, var(--surface-border) 20%, transparent);
	}
	.envgrid-key-col {
		flex: 2;
		min-width: 0;
	}
	.envgrid-val-col {
		flex: 3;
		min-width: 0;
		border-left: 1px solid var(--surface-border);
	}
	.envgrid-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		background: transparent;
		border: none;
		outline: none;
		color: var(--center-channel-color);
	}
	.envgrid-key {
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.envgrid-val {
		color: var(--surface-muted);
	}
	.envgrid-input::placeholder {
		color: var(--surface-muted);
		opacity: 0.45;
		font-weight: 400;
	}
	.envgrid-actions {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		padding-right: 0.25rem;
		opacity: 0;
		transition: opacity var(--dur-fast);
	}
	.envgrid-row:hover .envgrid-actions,
	.envgrid-row:focus-within .envgrid-actions {
		opacity: 1;
	}
	.envgrid-action {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-xs);
		background: transparent;
		border: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.envgrid-action:hover {
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
	}
	.envgrid-action--secret {
		color: var(--status-warning);
		background: color-mix(in srgb, var(--status-warning) 12%, transparent);
	}
	.envgrid-action--sealed {
		cursor: default;
	}
	.envgrid-val--sealed::placeholder {
		font-style: italic;
	}
	.envgrid-action--delete:hover {
		color: var(--error-text-color, #ef4444);
		background-color: color-mix(in srgb, var(--error-text-color, #ef4444) 8%, transparent);
	}
	.envgrid-add {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.75rem 0.75rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--surface-muted);
		background: transparent;
		border: none;
		border-top: 1px dashed var(--surface-border);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.envgrid-add:hover {
		color: var(--sidebar-text-active-border);
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 6%, transparent);
	}
</style>
