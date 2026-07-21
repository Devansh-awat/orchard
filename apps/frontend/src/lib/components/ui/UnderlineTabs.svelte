<script lang="ts">
	type TabDef = { id: string; label: string; badge?: string | number };

	let {
		tabs,
		value = $bindable('')
	}: {
		tabs: TabDef[];
		value?: string;
	} = $props();
</script>

<nav class="ui-ultabs" role="tablist">
	{#each tabs as t (t.id)}
		<button
			type="button"
			class="ui-ultab"
			class:ui-ultab--active={value === t.id}
			aria-selected={value === t.id}
			role="tab"
			onclick={() => (value = t.id)}
		>
			{t.label}{#if t.badge !== undefined}<span class="ui-ultab-badge">{t.badge}</span>{/if}
		</button>
	{/each}
</nav>

<style>
	.ui-ultabs {
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid var(--border-default);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.ui-ultabs::-webkit-scrollbar {
		display: none;
	}
	.ui-ultab {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		margin-bottom: -1px;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-muted);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		white-space: nowrap;
		transition:
			color 120ms,
			border-color 120ms;
	}
	.ui-ultab:hover {
		color: var(--text-default);
	}
	.ui-ultab--active {
		color: var(--text-default);
		border-bottom-color: var(--accent);
	}
	.ui-ultab-badge {
		font-size: 0.625rem;
		font-weight: 650;
		line-height: 1;
		padding: 0.1875rem 0.375rem;
		border-radius: 999px;
		background-color: color-mix(in srgb, var(--text-default) 8%, transparent);
		color: var(--text-muted);
	}
</style>
