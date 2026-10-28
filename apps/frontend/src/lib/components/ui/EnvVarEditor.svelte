<script lang="ts" module>
	export interface EnvVarEditorRow {
		key: string;
		value: string;
		secret?: boolean;
	}

	export interface EnvVarIssue {
		tone: 'error' | 'warning';
		text: string;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { Eye, EyeOff, Lock, LockOpen, Plus, Trash2, TriangleAlert, X } from 'lucide-svelte';
	import { envVarsToRaw, rawToEnvVars } from '$lib/utils/format';
	import { presence } from '$lib/utils/transitions';
	import Button from './Button.svelte';
	import CopyButton from './CopyButton.svelte';
	import PopoverPanel from './PopoverPanel.svelte';
	import Textarea from './Textarea.svelte';
	import Tooltip from './Tooltip.svelte';

	let {
		rows = $bindable([] as EnvVarEditorRow[]),
		mode = $bindable('grid'),
		raw = $bindable(''),
		secrets = false,
		stored = new Set<string>(),
		issues = new Map<string, EnvVarIssue[]>(),
		reference = undefined,
		confirmSecret = false,
		minRows = 0,
		onedit = undefined
	}: {
		rows?: EnvVarEditorRow[];
		mode?: 'grid' | 'raw';
		raw?: string;
		secrets?: boolean;
		stored?: ReadonlySet<string>;
		issues?: ReadonlyMap<string, EnvVarIssue[]>;
		reference?: (key: string) => string;
		confirmSecret?: boolean;
		minRows?: number;
		onedit?: () => void;
	} = $props();

	let revealed = $state<Set<number>>(new Set());
	let replacing = $state<Set<number>>(new Set());
	let focusId: number | null = null;
	const ids = new WeakMap<EnvVarEditorRow, number>();
	let seq = 0;

	function idOf(row: EnvVarEditorRow) {
		let id = ids.get(row);
		if (id == null) {
			id = ++seq;
			ids.set(row, id);
		}
		return id;
	}
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

	$effect.pre(() => {
		void stored;
		untrack(() => {
			if (replacing.size) replacing = new Set();
		});
	});

	function blank(key = '', value = '', secret = false): EnvVarEditorRow {
		return secrets ? { key, value, secret } : { key, value };
	}

	function edited() {
		onedit?.();
	}

	function toggle(set: Set<number>, id: number) {
		const next = new Set(set);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	}

	function addRow() {
		rows = [...rows, blank()];
		edited();
	}

	function removeRow(i: number) {
		if (rows.length <= minRows) return;
		rows = rows.filter((_, idx) => idx !== i);
		edited();
	}

	function hasStored(row: EnvVarEditorRow) {
		return stored.has(row.key.trim());
	}

	function sealed(row: EnvVarEditorRow) {
		return (
			secrets && !!row.secret && hasStored(row) && row.value === '' && !replacing.has(idOf(row))
		);
	}

	function setSecret(row: EnvVarEditorRow, secret: boolean) {
		row.secret = secret;
		if (!secret && hasStored(row) && row.value === '') focusId = idOf(row);
		edited();
	}

	function replace(row: EnvVarEditorRow) {
		const id = idOf(row);
		replacing = new Set(replacing).add(id);
		focusId = id;
	}

	function keep(row: EnvVarEditorRow) {
		row.value = '';
		const next = new Set(replacing);
		next.delete(idOf(row));
		replacing = next;
		edited();
	}

	function claimFocus(id: number) {
		return (el: HTMLInputElement) => {
			if (focusId !== id) return;
			focusId = null;
			el.focus();
		};
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

	function masked(row: EnvVarEditorRow) {
		if (revealed.has(idOf(row))) return false;
		return secrets ? !!row.secret : true;
	}

	function placeholder(row: EnvVarEditorRow) {
		if (secrets && hasStored(row) && row.value === '') {
			return row.secret ? 'New value' : 'Type a new value';
		}
		return row.key.trim() ? 'value' : '';
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
		{#each rows as row, i (idOf(row))}
			{@const id = idOf(row)}
			{@const key = row.key.trim()}
			{@const found = (key && issues.get(key)) || []}
			{@const tone = found.some((f) => f.tone === 'error') ? 'error' : 'warning'}
			<div class="row" role="listitem" in:presence out:presence>
				<div class="key">
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
					{#if found.length}
						<Tooltip text={found.map((f) => f.text).join(' ')} delay={0}>
							<span
								class="issue issue--{tone}"
								role="img"
								aria-label={found.map((f) => f.text).join(' ')}
							>
								<TriangleAlert size={16} strokeWidth={2.25} />
							</span>
						</Tooltip>
					{/if}
				</div>
				{#if sealed(row)}
					<div class="cell--value value sealed">
						<span class="sealed-label">
							<Lock size={13} aria-hidden="true" />Hidden
							<Button
								variant="ghost"
								size="sm"
								icon={X}
								label="Clear the hidden value of {key} and type a new one"
								onclick={() => replace(row)}
							/>
						</span>
					</div>
				{:else}
					<div class="cell--value value">
						<input
							class="cell"
							type={masked(row) ? 'password' : 'text'}
							placeholder={placeholder(row)}
							aria-label={row.key ? `Value of ${row.key}` : 'Value'}
							autocomplete="off"
							spellcheck={false}
							bind:value={row.value}
							oninput={edited}
							onkeydown={(e) => {
								if (e.key === 'Escape' && replacing.has(id)) keep(row);
							}}
							onblur={() => {
								if (replacing.has(id) && row.value === '') keep(row);
							}}
							{@attach claimFocus(id)}
						/>
					</div>
				{/if}
				<div class="tools" class:tools--wide={secrets}>
					{#if (secrets ? row.secret : true) && !sealed(row)}
						<span class="tool">
							<Button
								variant="ghost"
								size="sm"
								icon={revealed.has(id) ? EyeOff : Eye}
								label={revealed.has(id) ? 'Hide value' : 'Show value'}
								onclick={() => (revealed = toggle(revealed, id))}
							/>
						</span>
					{/if}
					{#if reference && key}
						<span class="tool">
							<Tooltip text="Copy {reference(key)}">
								<CopyButton value={reference(key)} label="Copy reference to {key}" />
							</Tooltip>
						</span>
					{/if}
					{#if secrets}
						<span class="tool">
							{#if row.secret || !confirmSecret}
								<Button
									variant={row.secret ? 'tinted' : 'ghost'}
									size="sm"
									icon={row.secret ? Lock : LockOpen}
									label={row.secret ? 'Make plain' : 'Make secret'}
									aria-pressed={!!row.secret}
									onclick={() => setSecret(row, !row.secret)}
								/>
							{:else}
								<PopoverPanel placement="bottom-end">
									{#snippet trigger(attrs)}
										<Button
											{...attrs}
											variant="ghost"
											size="sm"
											icon={LockOpen}
											label="Make secret"
											aria-pressed={false}
										/>
									{/snippet}
									{#snippet children({ close })}
										<div class="confirm">
											<p class="confirm-title">Make {key || 'this value'} secret?</p>
											<p class="confirm-text">
												Once saved, nobody can read it again. You can still replace it.
											</p>
											<div class="confirm-actions">
												<Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
												<Button
													variant="primary"
													size="sm"
													icon={Lock}
													onclick={() => {
														setSecret(row, true);
														close();
													}}>Make secret</Button
												>
											</div>
										</div>
									{/snippet}
								</PopoverPanel>
							{/if}
						</span>
					{/if}
					<span class="tool">
						<Button
							variant="ghost"
							size="sm"
							icon={Trash2}
							label="Remove variable"
							disabled={rows.length <= minRows}
							onclick={() => removeRow(i)}
						/>
					</span>
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
	.key {
		display: flex;
		align-items: center;
		flex: 2;
		min-width: 0;
		padding-right: 0.5rem;
	}
	.cell--key {
		flex: 1;
		font-weight: var(--weight-medium);
	}
	.issue {
		display: grid;
		place-items: center;
		color: var(--status-warning);
	}
	.issue--error {
		color: var(--status-error);
	}
	.cell--value {
		flex: 3;
		min-width: 0;
		align-self: stretch;
		border-left: 1px solid var(--rule);
	}
	.value {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.value .cell {
		flex: 1;
		color: var(--text-muted);
	}
	.sealed-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		padding-left: 0.75rem;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.tools {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.125rem;
		flex-shrink: 0;
	}
	.tools--wide {
		width: 7.5rem;
	}
	.tool {
		display: inline-flex;
		opacity: 0;
		transition: opacity var(--fade-out) var(--curve-in);
	}
	.row:hover .tool,
	.row:has(:focus-visible) .tool,
	.tool:has(:popover-open) {
		opacity: 1;
		transition: opacity var(--fade-in) var(--curve-out);
	}
	.add {
		padding: 0.25rem;
	}
	.confirm {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		max-width: 17rem;
		padding: var(--space-3);
	}
	.confirm-title {
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.confirm-text {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>
