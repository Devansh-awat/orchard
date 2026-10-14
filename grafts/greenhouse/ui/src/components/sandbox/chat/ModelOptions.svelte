<script lang="ts">
	import { Check } from 'lucide-svelte';
	import { MenuItem } from '@orchardlabs/graft-ui';
	import { ocShortModelName, type OcModel, type OcModelGroup } from '../opencode';

	let {
		groups,
		providerID,
		modelID,
		onpick
	}: {
		groups: OcModelGroup[];
		providerID: string | null;
		modelID: string | null;
		onpick: (model: OcModel) => void;
	} = $props();

	function parts(model: OcModel): { label: string; fast: boolean } {
		const short = ocShortModelName(model.name);
		const fast = /\s+Fast$/i.test(short);
		return { label: fast ? short.replace(/\s+Fast$/i, '') : short, fast };
	}
</script>

{#each groups as group (group.name)}
	<div class="mo-group">{group.name}</div>
	{#each group.models as m (m.providerID + m.modelID)}
		{@const p = parts(m)}
		<MenuItem onclick={() => onpick(m)}>
			<span class="mo-label">{p.label}</span>
			{#if p.fast}<span class="mo-tag">Fast</span>{/if}
			<span class="mo-check">
				{#if m.providerID === providerID && m.modelID === modelID}
					<Check size={13} strokeWidth={1.75} />
				{/if}
			</span>
		</MenuItem>
	{/each}
{:else}
	<div class="mo-group">Loading models</div>
{/each}

<style>
	.mo-group {
		padding: var(--space-2) var(--space-3) var(--space-1);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-faint);
	}

	.mo-label {
		flex: 1;
		min-width: 0;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.mo-tag {
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.mo-check {
		display: inline-flex;
		justify-content: flex-end;
		width: 1rem;
		color: var(--text-muted);
	}
</style>
