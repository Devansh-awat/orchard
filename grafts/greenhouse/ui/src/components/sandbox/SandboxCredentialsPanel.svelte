<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Bot } from 'lucide-svelte';
	import { apiFetch, toasts } from '../../host/stores';
	import { queryClient } from '../../host/query';
	import { Button, Input, StatusBadge, statusMeta } from '@orchardlabs/graft-ui';
	import SettingsSection from '../user-settings/SettingsSection.svelte';
	import { sandboxCredentialsQueryOptions } from '../../lib/queries/sandboxes';

	let { index = 0 }: { index?: number } = $props();

	const credentialsQuery = createQuery(() => sandboxCredentialsQueryOptions());
	const credentials = $derived(credentialsQuery.data ?? null);

	let claudeInput = $state('');
	let openaiInput = $state('');
	let saving = $state<string | null>(null);

	async function put(body: Record<string, string | null>, action: string) {
		saving = action;
		try {
			const res = await apiFetch('/apiv1/sandboxes/credentials', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to update credentials');
			}
			claudeInput = '';
			openaiInput = '';
			queryClient.invalidateQueries({ queryKey: ['sandbox-credentials'] });
			toasts.add({ title: 'Credentials updated', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update credentials',
				color: 'error'
			});
		} finally {
			saving = null;
		}
	}
</script>

<SettingsSection
	{index}
	title="Agent credentials"
	description="Tokens are injected into your sandboxes so claude and codex run headlessly. Values are stored encrypted and never shown again."
>
	{#snippet icon(_hovered)}<Bot class="h-[18px] w-[18px]" />{/snippet}
	<div class="cred-body">
		<div class="cred-row">
			<div class="cred-head">
				<span class="cred-name">Claude Code</span>
				{#if credentials?.claude}
					<StatusBadge meta={statusMeta('success', 'Configured')} variant="plain" />
				{:else}
					<StatusBadge meta={statusMeta('neutral', 'Not set')} variant="plain" />
				{/if}
			</div>
			<p class="cred-hint">
				Run <code class="cred-code">claude setup-token</code> locally and paste the long-lived token.
			</p>
			<div class="cred-controls">
				<Input
					type="password"
					bind:value={claudeInput}
					placeholder="Paste token"
					autocomplete="off"
					aria-label="Claude Code token"
				/>
				<Button
					size="sm"
					variant="primary"
					disabled={!claudeInput.trim()}
					loading={saving === 'claude-save'}
					onclick={() => put({ claudeToken: claudeInput.trim() }, 'claude-save')}
				>
					Save
				</Button>
				{#if credentials?.claude}
					<Button
						size="sm"
						variant="ghost"
						loading={saving === 'claude-clear'}
						onclick={() => put({ claudeToken: null }, 'claude-clear')}
					>
						Clear
					</Button>
				{/if}
			</div>
		</div>
		<div class="cred-row">
			<div class="cred-head">
				<span class="cred-name">OpenAI / Codex</span>
				{#if credentials?.openai}
					<StatusBadge meta={statusMeta('success', 'Configured')} variant="plain" />
				{:else}
					<StatusBadge meta={statusMeta('neutral', 'Not set')} variant="plain" />
				{/if}
			</div>
			<p class="cred-hint">An OpenAI API key, exported for codex inside the sandbox.</p>
			<div class="cred-controls">
				<Input
					type="password"
					bind:value={openaiInput}
					placeholder="Paste token"
					autocomplete="off"
					aria-label="OpenAI token"
				/>
				<Button
					size="sm"
					variant="primary"
					disabled={!openaiInput.trim()}
					loading={saving === 'openai-save'}
					onclick={() => put({ openaiToken: openaiInput.trim() }, 'openai-save')}
				>
					Save
				</Button>
				{#if credentials?.openai}
					<Button
						size="sm"
						variant="ghost"
						loading={saving === 'openai-clear'}
						onclick={() => put({ openaiToken: null }, 'openai-clear')}
					>
						Clear
					</Button>
				{/if}
			</div>
		</div>
	</div>
</SettingsSection>

<style>
	.cred-body {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.cred-row {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.cred-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.cred-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.cred-hint {
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.cred-code {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		background: var(--bg-sunken);
		border-radius: var(--radius-xs);
		padding: 0.0625rem 0.375rem;
	}

	.cred-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.cred-controls :global(.input) {
		flex: 1;
		min-width: 0;
	}
</style>
