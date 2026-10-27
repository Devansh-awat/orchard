<script lang="ts">
	import { Plus, Trash2 } from 'lucide-svelte';
	import { rawToEnvVars } from '$lib/utils/format';

	let {
		envVars = $bindable([] as Array<{ key: string; value: string | null; secret?: boolean }>)
	}: {
		envVars?: Array<{ key: string; value: string | null; secret?: boolean }>;
	} = $props();

	function addRow() {
		envVars = [...envVars, { key: '', value: '' }];
	}

	function removeRow(i: number) {
		envVars = envVars.filter((_, idx) => idx !== i);
	}

	function onPaste(e: ClipboardEvent, i: number) {
		const text = e.clipboardData?.getData('text') ?? '';
		if (!text.includes('\n') && !text.includes('=')) return;
		const parsed = rawToEnvVars(text);
		if (parsed.length === 0) return;
		e.preventDefault();
		const next = [...envVars];
		next.splice(i, 1, ...parsed);
		envVars = next.filter((v, idx) => v.key || v.value || idx === next.length - 1);
	}
</script>

<div class="job-env-editor">
	{#each envVars as row, i (i)}
		<div class="job-env-row">
			<input
				class="input job-env-input font-mono"
				placeholder="KEY"
				bind:value={row.key}
				onpaste={(e) => onPaste(e, i)}
			/>
			<input
				class="input job-env-input font-mono"
				type={row.secret ? 'password' : 'text'}
				placeholder={row.secret ? 'Sealed, type to replace' : 'value'}
				bind:value={row.value}
			/>
			<button
				type="button"
				class="job-env-remove"
				aria-label="Remove variable"
				onclick={() => removeRow(i)}
			>
				<Trash2 size={14} />
			</button>
		</div>
	{/each}
	<button type="button" class="job-env-add" onclick={addRow}>
		<Plus size={13} />
		Add variable
	</button>
</div>
