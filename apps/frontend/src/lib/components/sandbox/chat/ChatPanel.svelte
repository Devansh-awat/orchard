<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Unplug } from 'lucide-svelte';
	import { Button, EmptyState } from '$lib/components/ui';
	import { sandboxCredentialsQueryOptions } from '$lib/queries/sandboxes';
	import type { ChatSessionStore, RemoteDraft, SlashCommand } from './session-store.svelte';
	import SessionTabs from './SessionTabs.svelte';
	import Transcript from './Transcript.svelte';
	import Composer from './Composer.svelte';

	let {
		store,
		tabs = false,
		remoteDrafts = [],
		commands = [],
		onComment = undefined,
		onTeamMessage = undefined
	}: {
		store: ChatSessionStore;
		tabs?: boolean;
		remoteDrafts?: RemoteDraft[];
		commands?: SlashCommand[];
		onComment?: (text: string) => void | Promise<void>;
		onTeamMessage?: (text: string) => void | Promise<void>;
	} = $props();

	const comment = $derived(onComment ?? onTeamMessage);

	const credentialsQuery = createQuery(() => sandboxCredentialsQueryOptions());
	const missingClaude = $derived(credentialsQuery.data ? !credentialsQuery.data.claude : false);
	const ready = $derived(store.connection === 'ready');
</script>

{#if store.connection === 'unreachable'}
	<div class="chat-unreachable">
		<EmptyState
			title="The agent isn't answering yet"
			description="opencode usually comes up a few seconds after the sandbox boots. We'll keep checking."
		>
			{#snippet icon()}<Unplug class="h-5 w-5" />{/snippet}
			<Button onclick={() => store.retry()}>Try again</Button>
		</EmptyState>
	</div>
{:else}
	{#if tabs && ready}<SessionTabs {store} />{/if}
	{#if missingClaude}
		<div class="chat-cred">
			<span>No Claude credentials on your account.</span>
			<a href="/user/settings?tab=sandbox">Open user settings</a>
		</div>
	{/if}
	<Transcript {store} />
	{#if ready}
		<div class="chat-dock">
			<div class="chat-col">
				<Composer {store} {remoteDrafts} {commands} onComment={comment} />
			</div>
		</div>
	{/if}
{/if}

<style>
	.chat-unreachable {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		padding: 2.5rem 1rem;
	}

	.chat-cred {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		flex-shrink: 0;
		padding: var(--space-2) var(--space-4);
		border-bottom: 1px solid var(--border-default);
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.chat-cred a {
		color: var(--text-link);
		text-decoration: none;
	}

	.chat-cred a:hover {
		text-decoration: underline;
	}

	.chat-dock {
		flex-shrink: 0;
		padding: 0 0 var(--space-4);
	}

	.chat-col {
		--chat-gutter: 2rem;
		width: 100%;
		max-width: calc(42.5rem + 2 * var(--chat-gutter));
		margin: 0 auto;
		padding: 0 var(--chat-gutter);
	}
</style>
