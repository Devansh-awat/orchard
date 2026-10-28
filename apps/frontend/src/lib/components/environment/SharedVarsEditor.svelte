<script lang="ts">
	import { untrack } from 'svelte';
	import { KeyRound, Plus } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { envVarsToRaw, rawToEnvVars } from '$lib/utils/format';
	import { presence } from '$lib/utils/transitions';
	import {
		Alert,
		Button,
		EmptyState,
		EnvVarEditor,
		FormActions,
		SectionTitle,
		SegmentedControl,
		Skeleton,
		Stack,
		Swap,
		type EnvVarEditorRow,
		type EnvVarIssue
	} from '$lib/components/ui';
	import type { SharedVar, SharedVarWarning } from '$lib/types/environments';

	let {
		environmentId,
		envName = ''
	}: {
		environmentId: string;
		envName?: string;
		envSlug?: string;
	} = $props();

	type Mode = 'grid' | 'raw';
	type Draft = { key: string; value: string; secret: boolean };

	const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
	const REF_RE = /\$\{\{\s*shared\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
	const MODES = [
		{ value: 'grid', label: 'Editor' },
		{ value: 'raw', label: 'Raw' }
	];

	let saved = $state<SharedVar[]>([]);
	let rows = $state<EnvVarEditorRow[]>([]);
	let raw = $state('');
	let mode = $state<Mode>('grid');
	let started = $state(false);
	let loading = $state(true);
	let failed = $state(false);
	let saving = $state(false);
	let serverWarnings = $state<SharedVarWarning[]>([]);
	let request = 0;

	const place = $derived(envName || 'this environment');
	const storedSecrets = $derived(new Set(saved.filter((v) => v.secret).map((v) => v.key)));
	const secretFlags = $derived(new Set(rows.filter((r) => r.secret).map((r) => r.key.trim())));

	const draft = $derived.by<Draft[]>(() => {
		const source =
			mode === 'raw'
				? rawToEnvVars(raw).map((p) => ({ ...p, secret: secretFlags.has(p.key) }))
				: rows;
		return source
			.filter((r) => r.key.trim())
			.map((r) => ({ key: r.key.trim(), value: r.value, secret: !!r.secret }));
	});

	const dirty = $derived(
		fingerprint(draft) !==
			fingerprint(saved.map((v) => ({ key: v.key, value: v.value ?? '', secret: v.secret })))
	);

	const issues = $derived.by(() => {
		const out = new Map<string, EnvVarIssue[]>();
		const add = (key: string, issue: EnvVarIssue) => {
			const list = out.get(key) ?? [];
			if (!list.some((i) => i.text === issue.text)) out.set(key, [...list, issue]);
		};
		const defined = new Set(draft.map((v) => v.key));
		const seen = new Set<string>();
		for (const v of draft) {
			if (!KEY_RE.test(v.key)) {
				add(v.key, {
					tone: 'error',
					text: 'Use letters, digits and underscores, and do not start with a digit.'
				});
			}
			if (seen.has(v.key)) add(v.key, { tone: 'error', text: 'This name is set more than once.' });
			seen.add(v.key);
			if (!v.secret && v.value === '' && storedSecrets.has(v.key)) {
				add(v.key, {
					tone: 'error',
					text: 'The old value stays hidden, so type a new one to make it plain.'
				});
			}
			for (const m of v.value.matchAll(REF_RE)) {
				if (!defined.has(m[1])) add(v.key, missing(m[1]));
			}
		}
		for (const w of serverWarnings) {
			if (!defined.has(w.missingRef) && defined.has(w.key)) add(w.key, missing(w.missingRef));
		}
		return out;
	});

	const blocking = $derived([...issues.values()].flat().filter((i) => i.tone === 'error').length);
	const listed = $derived(
		[...issues].flatMap(([key, list]) => list.map((i) => ({ ...i, text: `${key}: ${i.text}` })))
	);

	function missing(ref: string): EnvVarIssue {
		return {
			tone: 'warning',
			text: `\${{shared.${ref}}} is not defined in ${place}, so it resolves to an empty string.`
		};
	}

	function reference(key: string) {
		return `\${{shared.${key}}}`;
	}

	const empty = $derived(saved.length === 0 && !started && mode === 'grid');
	const view = $derived(empty ? 'empty' : mode);

	function fingerprint(vars: Draft[]) {
		return JSON.stringify([...vars].sort((a, b) => a.key.localeCompare(b.key)));
	}

	function reconcile(vars: SharedVar[]) {
		const pool = new Map<string, EnvVarEditorRow[]>();
		for (const r of rows) {
			const key = r.key.trim();
			pool.set(key, [...(pool.get(key) ?? []), r]);
		}
		return vars.map((v) => {
			const value = v.value ?? '';
			const row = pool.get(v.key)?.shift();
			if (!row) return { key: v.key, value, secret: v.secret };
			row.key = v.key;
			row.value = value;
			row.secret = v.secret;
			return row;
		});
	}

	function apply(vars: SharedVar[]) {
		saved = vars;
		rows = reconcile(vars);
		raw = envVarsToRaw(rows);
		started = false;
		if (vars.length === 0) mode = 'grid';
	}

	async function load(id: string, quiet = false) {
		const ticket = ++request;
		if (!quiet) loading = true;
		try {
			const res = await apiFetch(`/apiv1/environments/${id}/shared-vars`);
			if (!res.ok) throw new Error();
			const data: SharedVar[] = await res.json();
			if (ticket !== request) return;
			const order = new Map(draft.map((v, i) => [v.key, i]));
			if (quiet) data.sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
			failed = false;
			apply(data);
		} catch {
			if (ticket === request && !quiet) failed = true;
		} finally {
			if (ticket === request) loading = false;
		}
	}

	$effect(() => {
		const id = environmentId;
		untrack(() => {
			serverWarnings = [];
			load(id);
		});
	});

	function switchMode(next: string) {
		if (next === mode) return;
		if (next === 'raw') {
			raw = envVarsToRaw(rows);
		} else {
			const parsed = rawToEnvVars(raw).map((p) => ({ ...p, secret: secretFlags.has(p.key) }));
			rows = [...parsed, { key: '', value: '', secret: false }];
		}
		started = true;
		mode = next as Mode;
	}

	function addFirst() {
		rows = [{ key: '', value: '', secret: false }];
		started = true;
	}

	function discard() {
		apply(saved);
	}

	async function save() {
		saving = true;
		try {
			const vars = draft.map((v) => ({
				key: v.key,
				value: v.value === '' && storedSecrets.has(v.key) ? null : v.value,
				secret: v.secret
			}));
			const res = await apiFetch(`/apiv1/environments/${environmentId}/shared-vars`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ vars })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Shared variables did not save');
			}
			const result = await res.json();
			serverWarnings = result.warnings ?? [];
			toasts.add({ title: 'Shared variables saved', color: 'success' });
			await load(environmentId, true);
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Shared variables did not save',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}
</script>

<Stack gap="md">
	<div class="head">
		<SectionTitle size="md" title="Shared variables" count={draft.length || undefined}>
			{#snippet actions()}
				{#if !loading && !failed}
					<SegmentedControl
						label="Editor mode"
						size="sm"
						options={MODES}
						bind:value={() => mode, switchMode}
					/>
				{/if}
			{/snippet}
		</SectionTitle>
	</div>

	{#if loading}
		<Skeleton height="6rem" rounded="var(--radius-control)" />
	{:else if failed}
		<Alert tone="error" title="Shared variables did not load">
			{#snippet actions()}
				<Button variant="secondary" size="sm" onclick={() => load(environmentId)}>Retry</Button>
			{/snippet}
		</Alert>
	{:else}
		<Swap key={view}>
			{#if view === 'empty'}
				<EmptyState title="No shared variables in {place}">
					{#snippet icon()}<KeyRound size={18} />{/snippet}
					<Button variant="primary" icon={Plus} onclick={addFirst}>Add variable</Button>
				</EmptyState>
			{:else}
				<EnvVarEditor
					bind:rows
					bind:raw
					{mode}
					secrets
					stored={storedSecrets}
					{issues}
					{reference}
					confirmSecret
				/>
			{/if}
		</Swap>

		{#if mode === 'raw' && listed.length > 0}
			<div in:presence out:presence>
				<Alert tone={blocking > 0 ? 'error' : 'warning'}>
					<ul class="problems">
						{#each listed as issue (issue.text)}<li>{issue.text}</li>{/each}
					</ul>
				</Alert>
			</div>
		{/if}

		{#if !empty}
			<div in:presence out:presence>
				<FormActions>
					<Button variant="ghost" disabled={!dirty || saving} onclick={discard}>Discard</Button>
					<Button
						variant="primary"
						loading={saving}
						disabled={!dirty || blocking > 0}
						onclick={save}>Save</Button
					>
				</FormActions>
			</div>
		{/if}
	{/if}
</Stack>

<style>
	.head {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.problems {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
</style>
