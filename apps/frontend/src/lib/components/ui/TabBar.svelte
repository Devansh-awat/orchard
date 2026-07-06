<script lang="ts">
	import { Tabs } from 'melt/builders';
	import type { Snippet } from 'svelte';

	type TabDef = { id: string; label: string; icon?: unknown };

	let {
		tabs,
		value = $bindable(''),
		tab = undefined
	}: {
		tabs: TabDef[];
		value?: string;
		tab?: Snippet<[TabDef, boolean]>;
	} = $props();

	const builder = new Tabs<string>({
		value: () => value || tabs[0]?.id || '',
		onValueChange: (v) => (value = v),
		loop: true
	});
</script>

<nav class="ui-tabs" {...builder.triggerList}>
	{#each tabs as t (t.id)}
		<button class="ui-tab" {...builder.getTrigger(t.id)}>
			{#if tab}
				{@render tab(t, value === t.id)}
			{:else}
				{@const Icon = t.icon as any}
				{#if Icon}<Icon size={14} />{/if}
				<span>{t.label}</span>
			{/if}
		</button>
	{/each}
</nav>
