<script lang="ts">
	import { onMount } from 'svelte';
	import { Github, Link2, MessageSquare, SquareKanban } from 'lucide-svelte';
	import { Button, Input, Skeleton, StatusBadge, statusMeta } from '@orchardlabs/graft-ui';
	import { toasts } from '../../host/stores';
	import {
		connectLinear,
		disconnectLinear,
		linkedIntegrations,
		linearStatus,
		unlinkSlack,
		type LinkedIntegration,
		type LinearStatus
	} from '../greenhouse/integrations';
	import SettingsSection from './SettingsSection.svelte';

	let { index = 0 }: { index?: number } = $props();

	let loading = $state(true);
	let failed = $state(false);
	let accounts = $state.raw<LinkedIntegration[]>([]);
	let linear = $state.raw<LinearStatus | null>(null);
	let linearOpen = $state(false);
	let apiKey = $state('');
	let busy = $state<string | null>(null);
	let linearError = $state<string | null>(null);

	const github = $derived(accounts.find((a) => a.provider === 'github') ?? null);
	const slack = $derived(accounts.find((a) => a.provider === 'slack') ?? null);
	const linearOn = $derived(linear?.connected ?? accounts.some((a) => a.provider === 'linear'));

	async function load() {
		try {
			const [list, status] = await Promise.all([
				linkedIntegrations(),
				linearStatus().catch(() => null)
			]);
			accounts = list.integrations ?? [];
			linear = status;
			failed = false;
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function saveLinear() {
		const key = apiKey.trim();
		if (!key || busy) return;
		busy = 'linear';
		linearError = null;
		try {
			linear = await connectLinear(key);
			apiKey = '';
			linearOpen = false;
			toasts.add({
				title: `Linear connected to ${linear.workspaceName ?? 'your workspace'}`,
				color: 'success'
			});
			await load();
		} catch (e) {
			linearError = e instanceof Error ? e.message : 'Linear refused that key';
		} finally {
			busy = null;
		}
	}

	async function dropLinear() {
		if (busy) return;
		busy = 'linear';
		try {
			linear = await disconnectLinear();
			await load();
		} catch (e) {
			toasts.add({
				title: "Couldn't disconnect Linear",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}

	async function dropSlack() {
		if (busy) return;
		busy = 'slack';
		try {
			await unlinkSlack();
			await load();
			toasts.add({ title: 'Slack unlinked', color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't unlink Slack",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}

	const connected = (on: boolean) =>
		statusMeta(on ? 'success' : 'neutral', on ? 'Connected' : 'Not connected');
</script>

<SettingsSection
	{index}
	title="Connected accounts"
	description="Start Greenhouse sessions from issues and chat. Each account is linked by you, never matched by email."
>
	{#snippet icon(_hovered)}<Link2 class="h-[18px] w-[18px]" />{/snippet}

	{#if loading}
		<div class="rows">
			<Skeleton class="h-10 w-full" />
			<Skeleton class="h-10 w-full" />
			<Skeleton class="h-10 w-full" />
		</div>
	{:else if failed}
		<p class="muted">Couldn't load your connected accounts. Greenhouse may be turned off here.</p>
	{:else}
		<div class="rows">
			<div class="row">
				<span class="ico"><Github size={16} /></span>
				<span class="who">
					<span class="name">GitHub</span>
					<span class="meta">
						{github?.account
							? `@${github.account}. Issues, pushes and pull requests use this account.`
							: 'Needed to pick GitHub issues and to push from a machine.'}
					</span>
				</span>
				<StatusBadge meta={connected(!!github)} variant="plain" />
				<Button variant="secondary" size="sm" href="/user/settings?tab=connections">
					{github ? 'Manage' : 'Connect'}
				</Button>
			</div>

			<div class="row row--stack">
				<div class="row-line">
					<span class="ico"><SquareKanban size={16} /></span>
					<span class="who">
						<span class="name">Linear</span>
						<span class="meta">
							{linearOn
								? `${linear?.workspaceName ?? 'Workspace connected'}. Your key is stored encrypted.`
								: 'Paste a personal API key to pick Linear issues when you start a session.'}
						</span>
					</span>
					<StatusBadge meta={connected(linearOn)} variant="plain" />
					{#if linearOn}
						<Button variant="secondary" size="sm" loading={busy === 'linear'} onclick={dropLinear}>
							Disconnect
						</Button>
					{:else if !linearOpen}
						<Button variant="secondary" size="sm" onclick={() => (linearOpen = true)}
							>Connect</Button
						>
					{/if}
				</div>
				{#if linearOpen && !linearOn}
					<div class="form">
						<p class="muted">
							Create one in Linear under Settings, Account, Security & Access, Personal API keys.
							Read access is enough.
						</p>
						<div class="form-row">
							<div class="grow">
								<Input
									type="password"
									placeholder="lin_api_..."
									aria-label="Linear API key"
									bind:value={apiKey}
									onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && saveLinear()}
								/>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => {
									linearOpen = false;
									apiKey = '';
									linearError = null;
								}}>Cancel</Button
							>
							<Button
								variant="primary"
								size="sm"
								loading={busy === 'linear'}
								disabled={!apiKey.trim()}
								onclick={saveLinear}
							>
								Connect
							</Button>
						</div>
						{#if linearError}<p class="error">{linearError}</p>{/if}
					</div>
				{/if}
			</div>

			<div class="row">
				<span class="ico"><MessageSquare size={16} /></span>
				<span class="who">
					<span class="name">Slack</span>
					<span class="meta">
						{#if slack}
							Linked{slack.account ? ` in workspace ${slack.account}` : ''}.
							<span class="code">/greenhouse</span> in Slack starts sessions as you.
						{:else}
							Run <span class="code">/greenhouse link</span> in Slack and open the link it sends you.
						{/if}
					</span>
				</span>
				<StatusBadge meta={connected(!!slack)} variant="plain" />
				{#if slack}
					<Button variant="secondary" size="sm" loading={busy === 'slack'} onclick={dropSlack}>
						Unlink
					</Button>
				{/if}
			</div>
		</div>
	{/if}
</SettingsSection>

<style>
	.rows {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.row,
	.row-line {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.row {
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		background-color: var(--fill-quiet);
	}

	.row--stack {
		flex-direction: column;
		align-items: stretch;
		gap: var(--space-3);
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		color: var(--text-muted);
	}

	.who {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.name {
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		font-weight: 600;
		color: var(--text-default);
	}

	.meta,
	.muted {
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.muted {
		margin: 0;
	}

	.code {
		font-family: var(--font-mono-terminal);
		color: var(--text-default);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-left: calc(1rem + var(--space-3));
	}

	.form-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	.error {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		font-weight: 600;
		color: var(--status-error);
	}
</style>
