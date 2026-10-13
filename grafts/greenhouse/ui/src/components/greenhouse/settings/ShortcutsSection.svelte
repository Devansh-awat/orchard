<script lang="ts">
	import { isMac } from '../format';
	import { greenhousePrefs } from '../prefs.svelte';
	import Card from './Card.svelte';
	import { shortcutGroups } from './shortcut-groups';

	const mac = isMac();
	const groups = $derived(
		shortcutGroups(mac, greenhousePrefs.values.sendWith, greenhousePrefs.values.followUp)
	);
</script>

{#each groups as group (group.title)}
	<Card title={group.title}>
		<ul class="list">
			{#each group.items as item (item.label)}
				<li class="item">
					<span class="label">{item.label}</span>
					<span class="keys">
						{#each item.keys as key, i (i)}
							<kbd class="kbd">{key}</kbd>
						{/each}
					</span>
				</li>
			{/each}
		</ul>
	</Card>
{/each}

<style>
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 2.5rem;
		padding: 0.5rem 1rem;
	}

	.item + .item {
		border-top: 1px solid var(--gh-line-soft);
	}

	.label {
		min-width: 0;
		font-size: var(--text-footnote);
		line-height: var(--gh-lh-ui);
		color: var(--text-default);
	}

	.keys {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
	}

	.kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.3125rem;
		border: 1px solid var(--rule);
		border-radius: var(--radius-xs);
		background: var(--fill-soft);
		color: var(--text-muted);
		font-family: inherit;
		font-size: var(--text-micro);
		font-weight: 600;
		line-height: 1;
	}
</style>
