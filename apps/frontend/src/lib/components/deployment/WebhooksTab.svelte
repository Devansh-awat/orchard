<script lang="ts">
	import { KeyRound, Plus, Trash2 } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import {
		ActivityGroup,
		ActivityRow,
		Alert,
		Button,
		Input,
		SegmentedControl,
		SectionTitle,
		Swap,
		ToneTile
	} from '$lib/components/ui';
	import DataPane from '$lib/components/ui/DataPane.svelte';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Snippet from '$lib/components/ui/Snippet.svelte';
	import Widget from '$lib/components/ui/Widget.svelte';
	import type { WebhookToken } from '$lib/types/deployment';

	let {
		webhookTokens,
		webhookTokensLoading,
		creatingWebhookToken,
		deletingWebhookTokenId,
		newlyCreatedToken = $bindable(null),
		onCreateToken,
		onDeleteToken
	}: {
		deploymentId: string;
		webhookTokens: WebhookToken[];
		webhookTokensLoading: boolean;
		creatingWebhookToken: boolean;
		deletingWebhookTokenId: string | null;
		newlyCreatedToken?: string | null;
		onCreateToken: (label: string) => void;
		onDeleteToken: (tokenId: string) => void;
	} = $props();

	const EXAMPLES = [
		{ value: 'restart', label: 'Restart' },
		{ value: 'tag', label: 'New tag' },
		{ value: 'image', label: 'New image' },
		{ value: 'actions', label: 'GitHub Actions' }
	];

	let label = $state('');
	let example = $state('restart');
	let deleting = $state<WebhookToken | null>(null);
	let confirmOpen = $state(false);

	const newUrl = $derived(newlyCreatedToken ? webhookUrl(newlyCreatedToken) : null);
	const target = $derived(newUrl ?? '$WEBHOOK_URL');
	const code = $derived(exampleCode(example, target));

	const SAMPLE_TOKENS: WebhookToken[] = [
		{ id: 's1', label: 'github-actions', createdAt: '', lastUsedAt: '2024-01-01T00:00:00Z' },
		{ id: 's2', label: 'deploy-hook', createdAt: '', lastUsedAt: null }
	];

	function webhookUrl(token: string): string {
		return `${window.location.origin}/apiv1/webhooks/deploy/${token}`;
	}

	function exampleCode(kind: string, url: string): string {
		if (kind === 'tag')
			return `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"tag": "v1.2.3"}'`;
		if (kind === 'image')
			return `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"image": "ghcr.io/org/app", "tag": "sha-abc123"}'`;
		if (kind === 'actions')
			return `- name: Deploy to Orchard\n  run: |\n    curl -s -X POST \${{ secrets.WEBHOOK_URL }} \\\n      -H "Content-Type: application/json" \\\n      -d '{"tag": "\${{ github.sha }}"}'`;
		return `curl -X POST ${url}`;
	}

	function create() {
		if (creatingWebhookToken) return;
		onCreateToken(label.trim());
		label = '';
	}

	function askDelete(token: WebhookToken) {
		deleting = token;
		confirmOpen = true;
	}

	function lastUsed(token: WebhookToken): string {
		if (!token.lastUsedAt) return 'Never used';
		return `Last used ${new Date(token.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
	}
</script>

<Widget title="Webhooks">
	<form
		class="create"
		onsubmit={(e) => {
			e.preventDefault();
			create();
		}}
	>
		<Input
			size="sm"
			placeholder="Label, like github-actions"
			aria-label="Token label"
			bind:value={label}
		/>
		<Button
			type="submit"
			variant="secondary"
			size="sm"
			icon={Plus}
			loading={creatingWebhookToken}
			disabled={creatingWebhookToken}>Create token</Button
		>
	</form>

	{#if newUrl && newlyCreatedToken}
		<Alert tone="success" title="Copy this now. You only see it once.">
			{#snippet icon()}<KeyRound size={16} />{/snippet}
			{#snippet actions()}
				<Button variant="ghost" size="sm" onclick={() => (newlyCreatedToken = null)}>Done</Button>
			{/snippet}
			<div class="secrets">
				<Snippet command={newUrl} prompt="" label="Copy webhook URL" />
				<Snippet command={newlyCreatedToken} prompt="" label="Copy token" />
			</div>
		</Alert>
	{/if}

	<DataPane
		data={webhookTokensLoading ? null : webhookTokens}
		sample={SAMPLE_TOKENS}
		empty={!webhookTokensLoading && webhookTokens.length === 0}
		label="Loading webhook tokens"
	>
		{#snippet children(tokens: WebhookToken[])}
			<ActivityGroup>
				{#each tokens as token (token.id)}
					<ActivityRow muted={!token.lastUsedAt}>
						{#snippet tile()}
							<ToneTile size={28}><KeyRound size={14} aria-hidden="true" /></ToneTile>
						{/snippet}
						{#snippet title()}<span class="name">{token.label || 'Unnamed token'}</span>{/snippet}
						{#snippet meta()}{lastUsed(token)}{/snippet}
						{#snippet time()}<RelativeTime date={token.createdAt} />{/snippet}
						{#snippet actions()}
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Delete {token.label || 'token'}"
								loading={deletingWebhookTokenId === token.id}
								disabled={deletingWebhookTokenId === token.id}
								onclick={() => askDelete(token)}
							/>
						{/snippet}
					</ActivityRow>
				{/each}
			</ActivityGroup>
		{/snippet}
	</DataPane>

	<div class="examples">
		<SectionTitle title="Examples">
			{#snippet actions()}
				<SegmentedControl
					options={EXAMPLES}
					bind:value={example}
					label="Example"
					size="sm"
					shape="capsule"
				/>
			{/snippet}
		</SectionTitle>
		<Swap key={example}>
			<CodeBlock {code} />
		</Swap>
	</div>
</Widget>

{#if deleting}
	<ConfirmModal
		bind:open={confirmOpen}
		title={`Delete ${deleting.label || 'this token'}?`}
		description="Anything calling this webhook stops deploying."
		confirmLabel="Delete token"
		onconfirm={() => {
			if (deleting) onDeleteToken(deleting.id);
			deleting = null;
		}}
		oncancel={() => (deleting = null)}
	/>
{/if}

<style>
	.create {
		display: flex;
		gap: 0.5rem;
	}
	.secrets {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.examples {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
</style>
