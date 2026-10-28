<script lang="ts" module>
	export interface EnvVarEditorRow {
		key: string;
		value: string;
		secret?: boolean;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { Eye, EyeOff, Lock, LockOpen, Plus, Trash2 } from 'lucide-svelte';
	import { envVarsToRaw, rawToEnvVars } from '$lib/utils/format';
	import Button from './Button.svelte';
	import Textarea from './Textarea.svelte';

	let {
		rows = $bindable([] as EnvVarEditorRow[]),
		mode = $bindable('grid'),
		raw = $bindable(''),
		secrets = false,
		minRows = 0,
		onedit = undefined
	}: {
		rows?: EnvVarEditorRow[];
		mode?: 'grid' | 'raw';
		raw?: string;
		secrets?: boolean;
		minRows?: number;
		onedit?: () => void;
	} = $props();

	let revealed = $state<Set<number>>(new Set());
	let shownMode = untrack(() => mode);

	$effect.pre(() => {
		const next = mode;
		if (next === shownMode) return;
		shownMode = next;
		untrack(() => {
			if (next === 'raw') {
				raw = envVarsToRaw(rows);
				return;
			}
			const secretKeys = new Set(rows.filter((r) => r.secret).map((r) => r.key));
			const parsed = rawToEnvVars(raw).map((p) => blank(p.key, p.value, secretKeys.has(p.key)));
			rows = [...parsed, blank()];
		});
	});

	function blank(key = '', value = '', secret = false): EnvVarEditorRow {
		return secrets ? { key, value, secret } : { key, value };
	}

	function edited() {
		onedit?.();
	}

	function toggleReveal(i: number) {
		const next = new Set(revealed);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		revealed = next;
	}

	function addRow() {
		rows = [...rows, blank()];
		edited();
	}

	function removeRow(i: number) {
		if (rows.length <= minRows) return;
		rows = rows.filter((_, idx) => idx !== i);
		revealed = new Set();
		edited();
	}

	function toggleSecret(row: EnvVarEditorRow) {
		row.secret = !row.secret;
		edited();
	}

	function onPaste(e: ClipboardEvent, i: number) {
		const text = e.clipboardData?.getData('text') ?? '';
		if (!text.includes('\n') && !text.includes('=')) return;
		const parsed = rawToEnvVars(text);
		if (parsed.length === 0) return;
		e.preventDefault();
		const next = [...rows];
		next.splice(i, 1, ...parsed.map((p) => blank(p.key, p.value)));
		rows = next;
		edited();
	}

	function masked(row: EnvVarEditorRow, i: number) {
		if (revealed.has(i)) return false;
		return secrets ? !!row.secret : true;
	}
</script>

{#if mode === 'raw'}
	<Textarea
		bind:value={raw}
		oninput={edited}
		mono
		rows={8}
		autoGrow
		maxRows={20}
		aria-label="Environment variables as a .env file"
		placeholder={'KEY1=value1\nKEY2=value2\n# Comments are ignored'}
	/>
{:else}
	<div class="sheet" role="list">
		{#each rows as row, i (i)}
			<div class="row" role="listitem">
				<input
					class="cell cell--key"
					placeholder="KEY"
					aria-label="Variable name"
					autocomplete="off"
					spellcheck={false}
					bind:value={row.key}
					oninput={edited}
					onpaste={(e) => onPaste(e, i)}
				/>
				<input
					class="cell cell--value"
					type={masked(row, i) ? 'password' : 'text'}
					placeholder={row.secret ? '••••••••' : row.key.trim() ? 'value' : ''}
					aria-label={row.key ? `Value of ${row.key}` : 'Value'}
					autocomplete="off"
					spellcheck={false}
					bind:value={row.value}
					oninput={edited}
				/>
				<div class="tools">
					<Button
						variant="ghost"
						size="sm"
						icon={revealed.has(i) ? EyeOff : Eye}
						label={revealed.has(i) ? 'Hide value' : 'Show value'}
						onclick={() => toggleReveal(i)}
					/>
					{#if secrets}
						<Button
							variant={row.secret ? 'tinted' : 'ghost'}
							size="sm"
							icon={row.secret ? Lock : LockOpen}
							label={row.secret ? 'Secret, stored in a Kubernetes Secret' : 'Mark as secret'}
							aria-pressed={!!row.secret}
							onclick={() => toggleSecret(row)}
						/>
					{/if}
					<Button
						variant="ghost"
						size="sm"
						icon={Trash2}
						label="Remove variable"
						disabled={rows.length <= minRows}
						onclick={() => removeRow(i)}
					/>
				</div>
			</div>
		{/each}
		<div class="add">
			<Button variant="ghost" size="sm" icon={Plus} onclick={addRow}>Add variable</Button>
		</div>
	</div>
{/if}

<style>
	.sheet {
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: inset 0 0 0 1px var(--rule);
		background: var(--bg-raised);
		overflow: clip;
	}
	.row {
		display: flex;
		align-items: center;
		min-height: 2.5rem;
		padding-right: 0.25rem;
		border-bottom: 1px solid var(--rule);
		transition: background-color var(--fade-in) var(--curve-out);
	}
	.row:hover,
	.row:focus-within {
		background: var(--bg-hover);
	}
	.cell {
		min-width: 0;
		height: 2.5rem;
		padding: 0 0.75rem;
		border: none;
		background: transparent;
		color: var(--text-default);
		font-family: var(--font-mono);
		font-size: var(--text-callout);
	}
	.cell:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}
	.cell::placeholder {
		color: var(--text-faint);
	}
	.cell--key {
		flex: 2;
		font-weight: var(--weight-medium);
	}
	.cell--value {
		flex: 3;
		border-left: 1px solid var(--rule);
		color: var(--text-muted);
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity var(--fade-out) var(--curve-in);
	}
	.row:hover .tools,
	.row:has(:focus-visible) .tools {
		opacity: 1;
		transition: opacity var(--fade-in) var(--curve-out);
	}
	.add {
		padding: 0.25rem;
	}
</style>
