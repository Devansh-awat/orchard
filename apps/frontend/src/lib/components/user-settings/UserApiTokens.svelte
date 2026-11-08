<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import { apiFetch, toasts } from '$lib/stores';
	import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import TokenOrgScope from './TokenOrgScope.svelte';
	import {
		Alert,
		Button,
		Field,
		Input,
		List,
		ListRow,
		Modal,
		ModalIntro,
		SecretString,
		SectionCard,
		SegmentedControl,
		Skeleton,
		Swap,
		ToneTile
	} from '$lib/components/ui';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';

	interface ApiToken {
		id: string;
		name: string;
		scopeOrganizationName?: string | null;
		lastUsedAt: string | null;
		expiresAt: string | null;
		createdAt: string;
	}

	const uid = $props.id();

	let tokens = $state<ApiToken[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let showCreate = $state(false);
	let newTokenName = $state('');
	let newTokenScope = $state<'read' | 'deploy' | 'exec'>('read');
	let newTokenOrg = $state('');
	const SCOPE_LADDER = ['read', 'deploy', 'exec'] as const;
	const scopeOptions = [
		{ value: 'read', label: 'Read' },
		{ value: 'deploy', label: 'Deploy' },
		{ value: 'exec', label: 'Exec' }
	] as const;
	const SCOPE_HINT = {
		read: 'Can read everything your account can, but not change it',
		deploy: 'Can also create, update and delete',
		exec: 'Can also open shells in your pods and databases'
	} as const;
	let creating = $state(false);
	let createdToken = $state<string | null>(null);
	let createdName = $state('');

	let deletingId = $state<string | null>(null);
	let showRevokeModal = $state(false);
	let tokenToRevoke = $state<ApiToken | null>(null);

	let renameOpen = $state(false);
	let renaming = $state(false);
	let tokenToRename = $state<ApiToken | null>(null);

	const USAGE_OPTIONS = [
		{ value: 'mcp', label: 'MCP client' },
		{ value: 'curl', label: 'API' }
	] as const;
	let usage = $state<'mcp' | 'curl'>('mcp');

	const mcpUrl = $derived(env.PUBLIC_MCP_URL || 'https://mcp.yourdomain.com/');
	const mcpConfig = $derived(`{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer orch_..."
      }
    }
  }
}`);
	const curl = $derived(`curl -H "Authorization: Bearer orch_..." \\
  ${page.url.origin}/apiv1/auth/me`);

	async function fetchTokens() {
		loading = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/auth/tokens');
			if (!response.ok) throw new Error("Couldn't load API tokens");
			const data = await response.json();
			tokens = data;
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't load tokens";
		} finally {
			loading = false;
		}
	}

	function openCreate() {
		newTokenName = '';
		newTokenScope = 'read';
		createdToken = null;
		showCreate = true;
	}

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => el.focus());
	}

	async function createToken() {
		if (creating || !newTokenName.trim()) return;
		creating = true;
		try {
			const response = await apiFetch('/apiv1/auth/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newTokenName.trim(),
					scopes: SCOPE_LADDER.slice(0, SCOPE_LADDER.indexOf(newTokenScope) + 1),
					...(newTokenOrg ? { organizationId: newTokenOrg } : {})
				})
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || "Couldn't create token");
			}
			const data = await response.json();
			createdName = newTokenName.trim();
			createdToken = data.token;
			newTokenName = '';
			newTokenScope = 'read';
			await fetchTokens();
		} catch (e) {
			toasts.add({
				title: "Couldn't create token",
				description: e instanceof Error ? e.message : "Couldn't create token",
				color: 'error'
			});
		} finally {
			creating = false;
		}
	}

	function closeCreated() {
		showCreate = false;
	}

	function confirmRevokeToken(token: ApiToken) {
		tokenToRevoke = token;
		showRevokeModal = true;
	}

	async function revokeToken(token: ApiToken) {
		deletingId = token.id;
		try {
			const response = await apiFetch(`/apiv1/auth/tokens/${token.id}`, {
				method: 'DELETE'
			});
			if (!response.ok) throw new Error("Couldn't revoke token");
			toasts.add({ title: 'Token revoked', color: 'success' });
			await fetchTokens();
		} catch (e) {
			toasts.add({
				title: "Couldn't revoke token",
				description: e instanceof Error ? e.message : "Couldn't revoke token",
				color: 'error'
			});
		} finally {
			deletingId = null;
		}
	}

	function openRename(token: ApiToken) {
		tokenToRename = token;
		renameOpen = true;
	}

	async function renameToken(name: string) {
		if (!tokenToRename) return;
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/auth/tokens/${tokenToRename.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || "Couldn't rename token");
			}
			toasts.add({ title: 'Token renamed', color: 'success' });
			renameOpen = false;
			tokenToRename = null;
			await fetchTokens();
		} catch (e) {
			toasts.add({
				title: "Couldn't rename token",
				description: e instanceof Error ? e.message : "Couldn't rename token",
				color: 'error'
			});
		} finally {
			renaming = false;
		}
	}

	function formatDate(value: string) {
		return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	onMount(() => {
		fetchTokens();
	});
</script>

<SectionCard title="API tokens">
	{#snippet actions()}
		<Button size="sm" icon={Plus} onclick={openCreate}>New token</Button>
	{/snippet}
	{#if error}
		<Alert tone="error">{error}</Alert>
	{:else if loading}
		<div class="placeholder">
			<Skeleton height="2.5rem" />
			<Skeleton height="2.5rem" />
		</div>
	{:else if tokens.length === 0}
		<p class="quiet">No tokens yet. Create one for the CLI, an MCP client or the API.</p>
	{:else}
		<List inset={false} label="API tokens">
			{#each tokens as token (token.id)}
				<ListRow flush presence title={token.name}>
					{#snippet leading()}<ToneTile size={32}><KeyRound size={16} /></ToneTile>{/snippet}
					{#snippet subtitle()}
						<span>
							{#if token.lastUsedAt}Used <RelativeTime date={token.lastUsedAt} />{:else}Never used{/if}
							· Created <RelativeTime date={token.createdAt} />
							{#if token.expiresAt}· Expires {formatDate(token.expiresAt)}{/if}
							{#if token.scopeOrganizationName}· Only works in {token.scopeOrganizationName}{/if}
						</span>
					{/snippet}
					{#snippet actions()}
						<Button
							size="sm"
							variant="ghost"
							icon={Pencil}
							label={`Rename ${token.name}`}
							onclick={() => openRename(token)}
						/>
						<Button
							size="sm"
							variant="ghost"
							icon={Trash2}
							label={`Revoke ${token.name}`}
							loading={deletingId === token.id}
							onclick={() => confirmRevokeToken(token)}
						/>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</SectionCard>

<SectionCard title="Usage">
	{#snippet actions()}
		<SegmentedControl
			label="Usage example"
			options={USAGE_OPTIONS}
			bind:value={usage}
			size="sm"
			shape="capsule"
		/>
	{/snippet}
	<Swap key={usage}>
		{#if usage === 'mcp'}
			<CodeBlock code={mcpConfig} title=".mcp.json" />
		{:else}
			<CodeBlock code={curl} title="curl" />
		{/if}
	</Swap>
</SectionCard>

<Modal
	bind:open={showCreate}
	size={createdToken ? 'md' : 'sm'}
	closable={false}
	dismissable={!createdToken}
	labelledby="{uid}-title"
>
	{#if createdToken}
		<div class="form">
			<ModalIntro
				id="{uid}-title"
				icon={KeyRound}
				tone="success"
				solid
				title={`${createdName} is ready`}
				description="Copy it now. It isn't shown again."
			/>
			<SecretString
				masked={`orch_${'•'.repeat(28)}`}
				resolve={async () => createdToken}
				label="Token"
			/>
		</div>
	{:else}
		<form
			class="form"
			onsubmit={(e) => {
				e.preventDefault();
				createToken();
			}}
		>
			<ModalIntro id="{uid}-title" icon={KeyRound} tone="accent" title="New token" />
			<Field label="Name" for="{uid}-name">
				<Input
					id="{uid}-name"
					bind:value={newTokenName}
					placeholder="Claude Code, CI"
					autocomplete="off"
					{@attach focusOnOpen}
				/>
			</Field>
			<Field label="Access" hint={SCOPE_HINT[newTokenScope]}>
				<SegmentedControl
					label="Token access"
					options={scopeOptions}
					bind:value={newTokenScope}
					grow
				/>
			</Field>
			<TokenOrgScope id="{uid}-org" bind:value={newTokenOrg} />
		</form>
	{/if}
	{#snippet footer()}
		{#if createdToken}
			<Button variant="primary" shape="capsule" onclick={closeCreated}>Done</Button>
		{:else}
			<Button
				variant="ghost"
				shape="capsule"
				disabled={creating}
				onclick={() => (showCreate = false)}>Cancel</Button
			>
			<Button
				variant="primary"
				shape="capsule"
				loading={creating}
				disabled={!newTokenName.trim()}
				onclick={createToken}>Create token</Button
			>
		{/if}
	{/snippet}
</Modal>

{#if tokenToRename}
	<RenameModal
		bind:open={renameOpen}
		title="Rename token"
		value={tokenToRename.name}
		saving={renaming}
		onSave={renameToken}
	/>
{/if}

{#if tokenToRevoke}
	<ConfirmModal
		bind:open={showRevokeModal}
		title={`Revoke ${tokenToRevoke.name}?`}
		description="Anything using this token stops working immediately."
		confirmLabel="Revoke token"
		onconfirm={() => revokeToken(tokenToRevoke!)}
		oncancel={() => {
			tokenToRevoke = null;
		}}
	/>
{/if}

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.quiet {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
