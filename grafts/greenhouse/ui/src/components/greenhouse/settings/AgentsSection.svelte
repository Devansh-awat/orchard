<script lang="ts">
	import { onMount } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { Button, StatusDot, statusMeta } from '@orchardlabs/graft-ui';
	import ProviderIcon from '../../sandbox/chat/ProviderIcon.svelte';
	import {
		agentUsageQueryOptions,
		fmtResetTime,
		type AgentUsage,
		type AgentUsageWindow
	} from '../../sandbox/chat/agent-usage';
	import { sandboxCredentialsQueryOptions } from '../../../lib/queries/sandboxes';
	import { agentLoginMethods } from '../api';
	import { getGreenhouseApp } from '../app.svelte';
	import type { MachineWorkspace } from '../workspace.svelte';
	import type { AcpCatalogEntry } from '../../sandbox/chat/session-store.svelte';
	import AgentSetup from './AgentSetup.svelte';
	import Card from './Card.svelte';

	let { ws }: { ws: MachineWorkspace | null } = $props();

	const app = getGreenhouseApp();
	const live = $derived(!!ws && !ws.lifecycleOnly && ws.running && ws.canEdit);
	const usageQuery = createQuery(() => agentUsageQueryOptions(ws?.sandboxId ?? '', live));
	const usage = $derived<AgentUsage | undefined>(usageQuery.data);
	const credentialsQuery = createQuery(() => ({ ...sandboxCredentialsQueryOptions(), enabled: live }));
	const credentials = $derived(credentialsQuery.data ?? null);
	const methodsQuery = createQuery(() => ({
		queryKey: ['agent-login-methods'],
		enabled: live,
		staleTime: Infinity,
		queryFn: async () => {
			const res = await agentLoginMethods(ws?.sandboxId ?? '');
			if (!res.ok) throw new Error(res.message);
			return res.data.agents;
		}
	}));
	const logins = $derived(methodsQuery.data ?? []);

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
	let open = $state<string | null>(null);

	onMount(() => {
		if (app.agentSetup) {
			open = app.agentSetup;
			app.agentSetup = null;
		}
	});

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
			void usageQuery.refetch();
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

	function claudeAccount(): string | null {
		if (!usage) return null;
		if (usage.available) {
			const plan = usage.plan ? `Claude ${usage.plan}` : usage.loginMethod;
			return [plan, usage.email].filter(Boolean).join(' · ') || null;
		}
		if (usage.reason === 'api_key') return 'Signed in with an API key';
		return null;
	}

	function agentDetail(agent: AcpCatalogEntry): string {
		if (!agent.installed) return 'Not on this machine. The default machine image ships it.';
		if (agent.available) {
			const account = agent.id === 'claude' ? claudeAccount() : null;
			if (account) return account;
			return agent.version ? `Version ${agent.version}` : 'Ready to chat';
		}
		if (!agent.error && store?.acpProbing) return 'Starting it up to check';
		return 'Not signed in yet';
	}

	function windowText(window: AgentUsageWindow): string {
		const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
		const resets = fmtResetTime(window.resetsAt);
		return resets ? `${used}% used, resets ${resets}` : `${used}% used`;
	}

	function toggle(id: string) {
		open = open === id ? null : id;
	}
</script>

{#if !ws || ws.lifecycleOnly}
	<p class="calm">Open a machine to set up its agents.</p>
{:else if !ws.running}
	<p class="calm">Start this machine to set up its agents.</p>
{:else if !ws.canEdit}
	<p class="calm">Only people who can edit this machine can set up its agents.</p>
{:else}
	<Card title="Coding agents">
		{#if store?.acpHost === 'missing'}
			<div class="account">
				<span class="who">
					<span class="name">The agent host isn't running on this machine</span>
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
				{@const info = logins.find((l) => l.agent === agent.id) ?? null}
				{@const expanded = open === agent.id && !!info}
				<div class="agent" class:agent--open={expanded}>
					<div class="account">
						<span class="mark"><ProviderIcon kind={agentKind(agent.id)} size={20} /></span>
						<span class="who">
							<span class="name">{agent.label}</span>
							<span class="detail" title={agent.error ?? agentDetail(agent)}>
								{agentDetail(agent)}
							</span>
						</span>
						<span class="state">
							<StatusDot meta={state} size={6} />
							{state.label}
						</span>
						{#if info && agent.installed}
							<Button
								variant={agent.available || expanded ? 'secondary' : 'primary'}
								size="sm"
								aria-expanded={expanded}
								onclick={() => toggle(agent.id)}
							>
								{expanded ? 'Close' : agent.available ? 'Manage' : 'Set up'}
							</Button>
						{/if}
					</div>
					{#if agent.id === 'claude' && windows.length > 0}
						<div class="usage">
							{#each windows as item (item.label)}
								<div class="usage-row">
									<span class="usage-label">{item.label}</span>
									<span class="meter" aria-hidden="true">
										<span
											class="meter-fill"
											style:width="{Math.max(0, Math.min(100, item.window.usedPercent))}%"
										></span>
									</span>
									<span class="usage-text">{windowText(item.window)}</span>
								</div>
							{/each}
							{#if usage?.available && usage.emailMasked}
								<span class="usage-note">This is the owner's account. Sessions on this machine use it.</span>
							{/if}
						</div>
					{/if}
					{#if expanded && info && ws}
						<div class="panel">
							<AgentSetup {ws} {info} {credentials} />
						</div>
					{/if}
				</div>
			{/each}
			<div class="account account--foot">
				<span class="who">
					<span class="detail">Pick an agent from the model picker in any session.</span>
				</span>
				<Button variant="ghost" size="sm" loading={checking} onclick={() => void recheck()}>
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


	.agent:not(:first-child),
	.account--foot {
		border-top: 1px solid var(--gh-line-soft);
	}

	.usage {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0 1rem 0.75rem 4rem;
	}

	.usage-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.usage-label {
		flex: none;
		width: 6rem;
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.usage-text {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.usage-note {
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-faint);
	}

	.panel {
		padding: 0 1rem 1rem;
	}
</style>
