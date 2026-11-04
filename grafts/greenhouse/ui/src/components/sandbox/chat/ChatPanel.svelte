<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { Unplug } from 'lucide-svelte';
	import { Button, EmptyState } from '@orchardlabs/graft-ui';
	import { sandboxCredentialsQueryOptions } from '../../../lib/queries/sandboxes';
	import type { ChatSessionStore, RemoteDraft } from './session-store.svelte';
	import type { SlashCommand, SlashNotice, SlashOption } from './slash-commands';
	import SessionTabs from './SessionTabs.svelte';
	import Transcript from './Transcript.svelte';
	import Composer from './Composer.svelte';
	import PendingDock from './PendingDock.svelte';

	let {
		store,
		tabs = false,
		remoteDrafts = [],
		commands = [],
		onComment = undefined,
		onTeamMessage = undefined,
		onCommand = undefined,
		options = undefined,
		empty = undefined
	}: {
		store: ChatSessionStore;
		tabs?: boolean;
		remoteDrafts?: RemoteDraft[];
		commands?: SlashCommand[];
		onComment?: (text: string) => void | Promise<void>;
		onTeamMessage?: (text: string) => void | Promise<void>;
		onCommand?: (
			command: SlashCommand,
			args: string,
			alias: string | null
		) => SlashNotice | null | void | Promise<SlashNotice | null | void>;
		options?: (command: SlashCommand) => SlashOption[];
		empty?: Snippet;
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
			description="opencode usually starts a few seconds after the sandbox boots. Orchard keeps checking."
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
			<a href="/user/settings?tab=sandbox">Open Account settings</a>
		</div>
	{/if}
	<Transcript {store} {empty} />
	{#if ready}
		<div class="chat-dock">
			<div class="chat-col chat-stack">
				<PendingDock {store} />
				<Composer {store} {remoteDrafts} {commands} onComment={comment} {onCommand} {options} />
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
		--chat-inset: 1rem;
		width: 100%;
		max-width: calc(42.5rem + 2 * (var(--chat-gutter) + var(--chat-inset)));
		margin: 0 auto;
		padding: 0 calc(var(--chat-gutter) + var(--chat-inset));
	}

	.chat-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	@container chat-pane (min-width: 48rem) {
		.chat-col {
			--chat-inset: 1.5rem;
		}
	}
</style>
