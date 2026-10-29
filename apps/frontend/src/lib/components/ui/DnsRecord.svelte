<script lang="ts">
	import CopyButton from './CopyButton.svelte';

	type DnsEntry = { type: string; name: string; value: string };

	let { records, label = 'DNS records' }: { records: DnsEntry[]; label?: string } = $props();
</script>

<div class="dns" role="list" aria-label={label}>
	{#each records as record (`${record.type}:${record.name}:${record.value}`)}
		<dl class="record" role="listitem">
			<div class="line">
				<dt>Type</dt>
				<dd><span class="value">{record.type}</span></dd>
			</div>
			<div class="line">
				<dt>Name</dt>
				<dd>
					<span class="value">{record.name}</span>
					<CopyButton value={record.name} label="Copy name" />
				</dd>
			</div>
			<div class="line">
				<dt>Value</dt>
				<dd>
					<span class="value">{record.value}</span>
					<CopyButton value={record.value} label="Copy value" />
				</dd>
			</div>
		</dl>
	{/each}
</div>

<style>
	.dns {
		display: flex;
		flex-direction: column;
		min-width: 0;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 0.5px var(--border-default);
	}
	.record {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0.25rem 0.25rem 0.25rem 0.75rem;
	}
	.record + .record {
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.line {
		display: grid;
		grid-template-columns: 3.5rem minmax(0, 1fr);
		align-items: center;
		gap: 0.75rem;
		min-height: 1.75rem;
	}
	dt {
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	dd {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
		margin: 0;
	}
	.value {
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		color: var(--text-default);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
