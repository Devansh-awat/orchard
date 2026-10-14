<script lang="ts">
	import { onMount } from 'svelte';
	import { Github, MessageSquare, SquareKanban } from 'lucide-svelte';
	import { Button, Field, Input, Skeleton } from '@orchardlabs/graft-ui';
	import { toasts } from '../../../host/stores';
	import {
		connectLinear,
		disconnectLinear,
		linearStatus,
		linkedIntegrations,
		unlinkSlack,
		type LinearStatus,
		type LinkedIntegration
	} from '../integrations';
	import FormError from '../FormError.svelte';
	import Card from './Card.svelte';
	import Row from './Row.svelte';
	import { errorText } from './sections';

	let loading = $state(true);
	let failed = $state(false);
	let accounts = $state.raw<LinkedIntegration[]>([]);
	let linear = $state.raw<LinearStatus | null>(null);
	let linearOpen = $state(false);
	let apiKey = $state('');
	let busy = $state<'linear' | 'slack' | null>(null);
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
			await load();
		} catch (e) {
			linearError = errorText(e) ?? 'Linear refused that key';
		} finally {
			busy = null;
		}
	}

	function cancelLinear() {
		linearOpen = false;
		apiKey = '';
		linearError = null;
	}

	async function dropLinear() {
		if (busy) return;
		busy = 'linear';
		try {
			linear = await disconnectLinear();
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not disconnect Linear',
				description: errorText(e),
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
		} catch (e) {
			toasts.add({ title: 'Could not unlink Slack', description: errorText(e), color: 'error' });
		} finally {
			busy = null;
		}
	}
</script>

{#if loading}
	<Card>
		<div class="loading">
			<Skeleton height="1.25rem" width="60%" />
			<Skeleton height="1.25rem" width="50%" />
			<Skeleton height="1.25rem" width="55%" />
		</div>
	</Card>
{:else if failed}
	<FormError message="Could not load your accounts" />
{:else}
	<Card title="Start sessions from">
		<Row title="GitHub" description={github?.account ? `@${github.account}` : 'Not connected'}>
			{#snippet icon()}<Github size={16} strokeWidth={1.75} />{/snippet}
			{#snippet control()}
				<Button variant="secondary" size="sm" href="/user/settings?tab=connections">
					{github ? 'Manage' : 'Connect'}
				</Button>
			{/snippet}
		</Row>

		<Row
			title="Linear"
			description={linearOn ? (linear?.workspaceName ?? 'Connected') : 'Not connected'}
		>
			{#snippet icon()}<SquareKanban size={16} strokeWidth={1.75} />{/snippet}
			{#snippet control()}
				{#if linearOn}
					<Button variant="secondary" size="sm" loading={busy === 'linear'} onclick={dropLinear}>
						Disconnect
					</Button>
				{:else if !linearOpen}
					<Button variant="secondary" size="sm" onclick={() => (linearOpen = true)}>Connect</Button>
				{/if}
			{/snippet}
			{#if linearOpen && !linearOn}
				<Field label="API key" for="gh-settings-linear" error={linearError}>
					<div class="key">
						<Input
							id="gh-settings-linear"
							type="password"
							placeholder="lin_api_..."
							autocomplete="off"
							bind:value={apiKey}
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									void saveLinear();
								}
							}}
						/>
						<Button variant="ghost" size="sm" onclick={cancelLinear}>Cancel</Button>
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
				</Field>
				<a
					class="link"
					href="https://linear.app/settings/account/security"
					target="_blank"
					rel="noreferrer">Get a key</a
				>
			{/if}
		</Row>

		<Row
			title="Slack"
			description={slack ? (slack.account ?? 'Linked') : 'Run /greenhouse link in Slack'}
		>
			{#snippet icon()}<MessageSquare size={16} strokeWidth={1.75} />{/snippet}
			{#snippet control()}
				{#if slack}
					<Button variant="secondary" size="sm" loading={busy === 'slack'} onclick={dropSlack}>
						Unlink
					</Button>
				{/if}
			{/snippet}
		</Row>
	</Card>
{/if}

<style>
	.loading {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
	}

	.key {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 28rem;
	}

	.link {
		align-self: flex-start;
		color: var(--gh-muted);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.link:hover {
		color: var(--gh-text);
	}

	.link:focus-visible {
		outline: none;
		border-radius: var(--gh-r-control);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
