<script lang="ts">
	import { onMount } from 'svelte';
	import { Github, MessageSquare, SquareKanban } from 'lucide-svelte';
	import { Button, Field, Input, Skeleton } from '$lib/components/ui';
	import { toasts } from '$lib/stores';
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
	import Block from './Block.svelte';
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
	<Block>
		<Skeleton height="1.25rem" width="60%" />
		<Skeleton height="1.25rem" width="50%" />
		<Skeleton height="1.25rem" width="55%" />
	</Block>
{:else if failed}
	<Block>
		<FormError message="Could not load your accounts" />
	</Block>
{:else}
	<Block>
		<div class="row">
			<span class="glyph"><Github size={16} strokeWidth={1.75} /></span>
			<span class="name">GitHub</span>
			<span class="value">{github?.account ? `@${github.account}` : 'Not connected'}</span>
			<a class="link" href="/user/settings?tab=connections">{github ? 'Manage' : 'Connect'}</a>
		</div>
	</Block>

	<Block>
		<div class="row">
			<span class="glyph"><SquareKanban size={16} strokeWidth={1.75} /></span>
			<span class="name">Linear</span>
			<span class="value">
				{linearOn ? (linear?.workspaceName ?? 'Connected') : 'Not connected'}
			</span>
			{#if linearOn}
				<button type="button" class="link" disabled={busy === 'linear'} onclick={dropLinear}>
					Disconnect
				</button>
			{:else if !linearOpen}
				<button type="button" class="link" onclick={() => (linearOpen = true)}>Connect</button>
			{/if}
		</div>
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
				class="link link--quiet"
				href="https://linear.app/settings/account/security"
				target="_blank"
				rel="noreferrer">Get a key</a
			>
		{/if}
	</Block>

	<Block>
		<div class="row">
			<span class="glyph"><MessageSquare size={16} strokeWidth={1.75} /></span>
			<span class="name">Slack</span>
			{#if slack}
				<span class="value">{slack.account ?? 'Linked'}</span>
				<button type="button" class="link" disabled={busy === 'slack'} onclick={dropSlack}>
					Unlink
				</button>
			{:else}
				<span class="value">Run <span class="gh-mono">/greenhouse link</span> in Slack</span>
			{/if}
		</div>
	</Block>
{/if}

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 1.75rem;
		min-width: 0;
	}

	.glyph {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		color: var(--gh-muted);
	}

	.name {
		flex: none;
		font-weight: 600;
		color: var(--gh-text);
	}

	.value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-muted);
	}

	.key {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 28rem;
	}

	.link {
		flex: none;
		justify-self: start;
		padding: 0;
		border: none;
		background: none;
		color: var(--gh-text);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		text-decoration-color: color-mix(in oklab, currentColor 40%, transparent);
		cursor: pointer;
	}

	.link:hover:not(:disabled) {
		text-decoration-color: currentColor;
	}

	.link:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.link:focus-visible {
		outline: none;
		border-radius: var(--gh-r-control);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.link--quiet {
		color: var(--gh-muted);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
	}
</style>
