<script lang="ts">
	import type { Snippet } from 'svelte';
	import { presence } from '$lib/utils/transitions';

	let {
		label = undefined,
		hint = undefined,
		error = undefined,
		for: htmlFor = undefined,
		required = false,
		layout = 'stack',
		split = false,
		children
	}: {
		label?: string;
		hint?: string | Snippet;
		error?: string | null;
		for?: string;
		required?: boolean;
		layout?: 'stack' | 'row';
		split?: boolean;
		children: Snippet;
	} = $props();
</script>

{#snippet message()}
	{#if error || hint}
		<div class="slot" in:presence={{ fade: false }} out:presence={{ fade: false }}>
			{#if error}
				<p class="msg msg--error" role="alert">{error}</p>
			{:else if hint}
				<p class="msg">
					{#if typeof hint === 'string'}{hint}{:else}{@render hint()}{/if}
				</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#if layout === 'row'}
	<div class="field field--row" class:field--split={split}>
		<div class="row-text">
			{#if label}<label class="label" for={htmlFor}
					>{label}{#if required}<span class="req" aria-hidden="true">*</span>{/if}</label
				>{/if}
			{@render message()}
		</div>
		<div class="row-control">{@render children()}</div>
	</div>
{:else}
	<div class="field">
		{#if label}<label class="label" for={htmlFor}
				>{label}{#if required}<span class="req" aria-hidden="true">*</span>{/if}</label
			>{/if}
		{@render children()}
		{@render message()}
	</div>
{/if}

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.label {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.field--row {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.row-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.row-control {
		flex-shrink: 0;
	}
	.field--split .row-control {
		flex: 0 0 61.8%;
		min-width: 0;
	}
	.req {
		margin-left: 0.125rem;
		color: var(--status-error);
	}
	.msg :global(code) {
		font-family: var(--font-mono);
		font-size: 0.95em;
		color: var(--text-default);
	}
	.slot {
		min-width: 0;
	}
	.msg {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.msg--error {
		color: var(--status-error);
	}
</style>
