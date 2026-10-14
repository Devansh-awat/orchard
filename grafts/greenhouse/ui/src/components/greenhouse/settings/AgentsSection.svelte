<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Button, StatusDot, statusMeta } from '@orchardlabs/graft-ui';
	import ProviderIcon from '../../sandbox/chat/ProviderIcon.svelte';
	import {
		agentUsageQueryOptions,
		fmtResetTime,
		usageUnavailableText,
		type AgentUsage,
		type AgentUsageWindow
	} from '../../sandbox/chat/agent-usage';
	import type { MachineWorkspace } from '../workspace.svelte';
	import type { AcpCatalogEntry } from '../../sandbox/chat/session-store.svelte';
	import Card from './Card.svelte';
	import Row from './Row.svelte';

	let { ws }: { ws: MachineWorkspace | null } = $props();

	const live = $derived(!!ws && !ws.lifecycleOnly && ws.running && ws.canEdit);
	const query = createQuery(() => agentUsageQueryOptions(ws?.sandboxId ?? '', live));
	const usage = $derived<AgentUsage | undefined>(query.data);

	const meta = $derived.by(() => {
		if (!usage) return statusMeta('neutral', query.isError ? 'Unavailable' : 'Checking');
		if (usage.available || usage.reason === 'api_key' || usage.reason === 'rate_limited') {
			return statusMeta('success', 'Connected');
		}
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

	const store = $derived(ws?.store ?? null);
	const agents = $derived(store?.acpCatalog ?? []);
	let checking = $state(false);

	$effect(() => {
		if (!live || !ws) return;
		const current = ws;
		void current.refreshAgents();
	});

	async function recheck() {
		if (!ws || checking) return;
		checking = true;
		try {
			await ws.refreshAgents(true);
		} finally {
			checking = false;
		}
	}

	function agentKind(id: string): 'anthropic' | 'openai' | 'other' {
		if (id === 'claude') return 'anthropic';
		if (id === 'codex') return 'openai';
		return 'other';
	}

	function agentMeta(agent: AcpCatalogEntry) {
		if (!agent.installed) return statusMeta('neutral', 'Not installed');
		if (agent.available) return statusMeta('success', 'Ready');
		if (!agent.error && store?.acpProbing) return statusMeta('neutral', 'Checking');
		return statusMeta('warning', 'Needs setup');
	}

	function agentDetail(agent: AcpCatalogEntry): string {
		if (!agent.installed) return 'Not on this machine. The default machine image ships it.';
		if (agent.available) return agent.version ? `Version ${agent.version}` : 'Ready to chat';
		if (agent.error) return agent.error;
		return store?.acpProbing ? 'Starting it up to check' : 'Not checked yet';
	}

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
	<Card title="Coding agents">
		{#if store?.acpHost === 'missing'}
			<div class="account">
				<span class="who">
					<span class="name">The agent host is not running on this machine</span>
					<span class="detail detail--wrap">
						Restart the machine to pick up Claude Code, opencode, fx and Codex chats. Machines
						started before the update keep using the built-in opencode chat until then.
					</span>
				</span>
				<Button variant="secondary" size="sm" loading={checking} onclick={() => void recheck()}>
					Check again
				</Button>
			</div>
		{:else if agents.length === 0}
			<div class="account">
				<span class="who">
					<span class="name">Looking for agents</span>
					<span class="detail">Asking the machine which agents it has</span>
				</span>
			</div>
		{:else}
			{#each agents as agent (agent.id)}
				{@const state = agentMeta(agent)}
				<div class="account">
					<span class="mark"><ProviderIcon kind={agentKind(agent.id)} size={20} /></span>
					<span class="who">
						<span class="name">{agent.label}</span>
						<span class="detail" title={agentDetail(agent)}>{agentDetail(agent)}</span>
					</span>
					<span class="state">
						<StatusDot meta={state} size={6} />
						{state.label}
					</span>
				</div>
			{/each}
			<div class="account account--foot">
				<span class="who">
					<span class="detail">Pick an agent from the model picker in any session.</span>
				</span>
				<Button variant="secondary" size="sm" loading={checking} onclick={() => void recheck()}>
					Check again
				</Button>
			</div>
		{/if}
	</Card>
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

	.detail--wrap {
		white-space: normal;
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
