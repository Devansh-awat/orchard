<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import { Check as CheckAnim, X as XAnim, Pencil as PencilAnim } from '@jis3r/icons';

	let {
		label,
		value,
		mono = false,
		editing = $bindable(false),
		editValue = $bindable(''),
		saving = false,
		onSave,
		onCancel,
		onStartEdit,
		onKeydown,
	}: {
		label: string;
		value: string;
		mono?: boolean;
		editing: boolean;
		editValue: string;
		saving: boolean;
		onSave: () => void;
		onCancel: () => void;
		onStartEdit: () => void;
		onKeydown: (e: KeyboardEvent) => void;
	} = $props();

	let cellHovered = $state(false);
	let saveBtnHovered = $state(false);
	let cancelBtnHovered = $state(false);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="sf-cell"
	class:sf-cell--editing={editing}
	onmouseenter={() => (cellHovered = true)}
	onmouseleave={() => (cellHovered = false)}
>
	<span class="sf-label">{label}</span>
	{#if editing}
		<div class="sf-edit">
			<input
				class="sf-input"
				class:sf-input--mono={mono}
				type="text"
				bind:value={editValue}
				onkeydown={onKeydown}
				autofocus
			/>
			<div class="sf-edit-actions">
				<button
					class="sf-action sf-action--save"
					onclick={onSave}
					disabled={saving}
					onmouseenter={() => (saveBtnHovered = true)}
					onmouseleave={() => (saveBtnHovered = false)}
				>
					{#if saving}<Loader2 class="h-3 w-3 animate-spin" />{:else}<CheckAnim size={14} animate={saveBtnHovered} />{/if}
				</button>
				<button
					class="sf-action"
					onclick={onCancel}
					onmouseenter={() => (cancelBtnHovered = true)}
					onmouseleave={() => (cancelBtnHovered = false)}
				>
					<XAnim size={14} animate={cancelBtnHovered} />
				</button>
			</div>
		</div>
	{:else}
		<div class="sf-display">
			<span class="sf-value" class:sf-value--mono={mono}>{value}</span>
			<button class="sf-edit-btn" onclick={onStartEdit}>
				<PencilAnim size={13} animate={cellHovered && !editing} />
			</button>
		</div>
	{/if}
</div>

<style>
	.sf-cell {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem 1.5rem;
		position: relative;
		transition: background-color 120ms;
	}
	.sf-cell:not(.sf-cell--editing):hover {
		background-color: color-mix(in srgb, var(--center-channel-color) 2.5%, transparent);
	}
	.sf-cell:not(.sf-cell--editing):hover .sf-edit-btn {
		opacity: 1;
	}
	.sf-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--surface-muted);
	}
	.sf-display {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-height: 1.625rem;
	}
	.sf-value {
		flex: 1;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--center-channel-color);
		min-width: 0;
	}
	.sf-value--mono {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-weight: 400;
	}
	.sf-edit-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		opacity: 0;
		transition: all 120ms;
		flex-shrink: 0;
	}
	.sf-edit-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
	}
	.sf-edit {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.sf-input {
		width: 100%;
		min-width: 0;
		padding: 0.3125rem 0.5rem;
		font-size: 0.875rem;
		border: 1px solid var(--sidebar-text-active-border);
		border-radius: 0.375rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		transition: border-color 150ms, box-shadow 150ms;
		line-height: 1.5;
	}
	.sf-input:focus { outline: none; }
	.sf-input::placeholder { color: color-mix(in srgb, var(--surface-muted) 55%, transparent); }
	.sf-input--mono {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-weight: 400;
	}
	.sf-edit-actions {
		display: flex;
		gap: 0.125rem;
	}
	.sf-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: all 120ms;
	}
	.sf-action:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
	}
	.sf-action--save { color: var(--button-bg); }
	.sf-action--save:hover {
		color: var(--button-bg);
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
	}
	.sf-action:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
