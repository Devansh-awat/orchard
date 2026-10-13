<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Button, StatusDot, statusMeta } from '@orchard/graft-ui';
	import ProviderIcon from '../../sandbox/chat/ProviderIcon.svelte';
	import {
		agentUsageQueryOptions,
		fmtResetTime,
		usageUnavailableText,
		type AgentUsage,
		type AgentUsageWindow
	} from '../../sandbox/chat/agent-usage';
	import type { MachineWorkspace } from '../workspace.svelte';
	import Card from './Card.svelte';
	import Row from './Row.svelte';

	let { ws }: { ws: MachineWorkspace | null } = $props();

	const live = $derived(!!ws && !ws.lifecycleOnly && ws.running && ws.canEdit);
	const query = createQuery(() => agentUsageQueryOptions(ws?.sandboxId ?? '', live));
	const usage = $derived<AgentUsage | undefined>(query.data);

	const meta = $derived.by(() => {
		if (!usage) return statusMeta('neutral', query.isError ? 'Unavailable' : 'Checking');
		if (usage.available || usage.reason === 'api_key') return statusMeta('success', 'Connected');
		if (usage.reason === 'no_token') return statusMeta('neutral', 'Not connected');
		return statusMeta('neutral', 'Unavailable');
	});

	const summary = $derived.by(() => {
		if (!usage) return query.isError ? 'Could not reach the machine' : 'Checking the host login';
		if (usage.available) {
			const plan = usage.plan ? `Claude ${usage.plan}` : usage.loginMethod;
			return [plan, usage.email].filter(Boolean).join(' · ');
		}
		if (usage.reason === 'api_key') return 'Signed in with an API key';
		if (usage.reason === 'forbidden') return 'Only people on this machine can see it';
		return usageUnavailableText(usage.reason);
	});

	const windows = $derived.by(() => {
		if (!usage?.available) return [];
		const out: { label: string; window: AgentUsageWindow }[] = [];
		if (usage.fiveHour) out.push({ label: '5 hour limit', window: usage.fiveHour });
		if (usage.sevenDay) out.push({ label: 'Weekly limit', window: usage.sevenDay });
		return out;
	});

	function windowText(window: AgentUsageWindow): string {
		const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
		const resets = fmtResetTime(window.resetsAt);
		return resets ? `${used}% used, resets ${resets}` : `${used}% used`;
	}
</script>

{#if !ws || ws.lifecycleOnly}
	<p class="calm">Open a machine to see its agent account.</p>
{:else if !ws.running}
	<p class="calm">Start this machine to see its agent account.</p>
{:else if !ws.canEdit}
	<p class="calm">Only people who can edit this machine can see its agent account.</p>
{:else}
	<Card title="Claude">
		<div class="account">
			<span class="mark"><ProviderIcon kind="anthropic" size={20} /></span>
			<span class="who">
				<span class="name">Claude Code</span>
				<span class="detail">{summary}</span>
			</span>
			<span class="state">
				<StatusDot {meta} size={6} />
				{meta.label}
			</span>
			<Button
				variant="secondary"
				size="sm"
				loading={query.isFetching}
				onclick={() => void query.refetch()}
			>
				Refresh
			</Button>
		</div>
		{#each windows as item (item.label)}
			<Row title={item.label} description={windowText(item.window)}>
				{#snippet control()}
					<span class="meter" aria-hidden="true">
						<span
							class="meter-fill"
							style:width="{Math.max(0, Math.min(100, item.window.usedPercent))}%"
						></span>
					</span>
				{/snippet}
			</Row>
		{/each}
	</Card>
	{#if usage?.available && usage.emailMasked}
		<p class="note">This is the host's account. Sessions on this machine use it.</p>
	{/if}
{/if}

<style>
	.calm {
		margin: 0;
		padding: 2rem 0;
		text-align: center;
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		color: var(--gh-muted);
	}

	.account {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		min-width: 0;
	}

	.mark {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		background: var(--fill-soft);
		color: var(--text-default);
	}

	.who {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		flex: 1;
		min-width: 0;
	}

	.name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.detail {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.meter {
		position: relative;
		display: block;
		width: 8rem;
		height: 0.25rem;
		overflow: hidden;
		border-radius: var(--radius-pill);
		background: var(--fill-medium);
	}

	.meter-fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: inherit;
		background: var(--text-muted);
	}

	.note {
		margin: 0.5rem 0 0;
		padding: 0 0.25rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}
</style>
