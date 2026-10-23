<script lang="ts">
	import type { Snippet } from 'svelte';
	import { TriangleAlert, CircleAlert, Info, CircleCheck } from 'lucide-svelte';

	let {
		tone = 'info',
		title = undefined,
		icon = undefined,
		actions = undefined,
		children = undefined
	}: {
		tone?: 'error' | 'warning' | 'info' | 'success';
		title?: string;
		icon?: Snippet;
		actions?: Snippet;
		children?: Snippet;
	} = $props();

	const DEFAULT_ICONS = {
		error: CircleAlert,
		warning: TriangleAlert,
		info: Info,
		success: CircleCheck
	} as const;
	const DefaultIcon = $derived(DEFAULT_ICONS[tone]);
</script>

<div class="notice notice--{tone}" role={tone === 'error' ? 'alert' : 'status'}>
	<span class="icon">
		{#if icon}{@render icon()}{:else}<DefaultIcon size={16} />{/if}
	</span>
	<div class="content">
		{#if title}<p class="title">{title}</p>{/if}
		{#if children}<div class="body">{@render children()}</div>{/if}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-card);
		box-shadow: inset 0 0 0 1px var(--tone-border);
		background: var(--tone-bg);
		color: var(--text-default);
	}
	.notice--info {
		--tone-bg: var(--blue-2);
		--tone-border: var(--blue-4);
		--tone-fg: var(--blue-9);
	}
	.notice--success {
		--tone-bg: var(--green-2);
		--tone-border: var(--green-4);
		--tone-fg: var(--green-9);
	}
	.notice--warning {
		--tone-bg: var(--amber-2);
		--tone-border: var(--amber-4);
		--tone-fg: var(--amber-9);
	}
	.notice--error {
		--tone-bg: var(--red-2);
		--tone-border: var(--red-4);
		--tone-fg: var(--red-9);
	}
	.icon {
		display: flex;
		flex-shrink: 0;
		padding-top: 0.125rem;
		color: var(--tone-fg);
	}
	.content {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		font-size: var(--text-body);
		line-height: var(--lh-body);
	}
	.title {
		font-weight: var(--weight-semibold);
	}
	.body {
		color: var(--text-muted);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		align-self: center;
	}
</style>
