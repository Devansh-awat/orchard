<script lang="ts">
	import { Plus, Trash2, Loader2, Copy, Check, Eye, GitBranch } from 'lucide-svelte';
	import { Button, Chip, Dropdown, Field, Input } from '$lib/components/ui';
	import SettingsSection from './SettingsSection.svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { toasts } from '$lib/stores';
	import { env } from '$env/dynamic/public';
	import {
		PROVIDERS,
		createGitConnection,
		deleteGitConnection,
		fetchGitConnections,
		fetchOauthAvailability,
		fetchWebhookSecret,
		oauthStartUrl,
		type OauthAvailability,
		providerLabel,
		type GitConnection,
		type GitProviderKind
	} from './git-connections';

	let { index = 0 }: { index?: number } = $props();
	const isOwner = true;

	let connections = $state<GitConnection[]>([]);
	let oauth = $state<OauthAvailability>({ gitlab: null, bitbucket: null });
	let loaded = $state(false);
	let formOpen = $state(false);
	let saving = $state(false);
	let busyId = $state<string | null>(null);
	let secrets = $state<Record<string, string>>({});
	let copied = $state<string | null>(null);

	let provider = $state<GitProviderKind>('gitlab');
	let name = $state('');
	let baseUrl = $state(PROVIDERS[0].baseUrl);
	let username = $state('');
	let token = $state('');

	const spec = $derived(PROVIDERS.find((p) => p.kind === provider) ?? PROVIDERS[0]);
	const apiBase = $derived(env.PUBLIC_BASE_DOMAIN ? `https://${env.PUBLIC_BASE_DOMAIN}` : '');

	async function load() {
		try {
			[connections, oauth] = await Promise.all([fetchGitConnections(), fetchOauthAvailability()]);
		} catch (e) {
			toasts.add({
				title: 'Could not load git providers',
				description: e instanceof Error ? e.message : '',
				color: 'error'
			});
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		load();
	});

	function pickProvider(kind: string) {
		provider = kind as GitProviderKind;
		const s = PROVIDERS.find((p) => p.kind === provider);
		baseUrl = s?.baseUrl ?? '';
	}

	function openForm() {
		formOpen = true;
		name = '';
		token = '';
		username = '';
		pickProvider(provider);
	}

	async function save() {
		saving = true;
		try {
			const created = await createGitConnection({
				provider,
				name: name.trim(),
				baseUrl: baseUrl.trim(),
				username: username.trim() || null,
				token: token.trim()
			});
			toasts.add({ title: `${created.name} connected`, color: 'success' });
			formOpen = false;
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not connect',
				description: e instanceof Error ? e.message : '',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove(c: GitConnection) {
		busyId = c.id;
		try {
			await deleteGitConnection(c.id);
			await load();
		} catch (e) {
			toasts.add({
				title: 'Still in use',
				description: e instanceof Error ? e.message : '',
				color: 'error'
			});
		} finally {
			busyId = null;
		}
	}

	async function reveal(c: GitConnection) {
		try {
			secrets = { ...secrets, [c.id]: await fetchWebhookSecret(c.id) };
		} catch (e) {
			toasts.add({
				title: 'Could not load the secret',
				description: e instanceof Error ? e.message : '',
				color: 'error'
			});
		}
	}

	async function copy(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
			setTimeout(() => {
				if (copied === key) copied = null;
			}, 1500);
		} catch {
			toasts.add({ title: text, color: 'info' });
		}
	}
</script>

<SettingsSection
	{index}
	title="Git providers"
	description="Deploy from GitLab, Gitea, Codeberg, Bitbucket or any git host"
>
	{#snippet icon()}<GitBranch size={18} />{/snippet}
	{#snippet actions()}
		{#if isOwner && !formOpen}
			<Button size="sm" onclick={openForm}>
				<Plus class="h-3.5 w-3.5" />
				<span>Add with a token</span>
			</Button>
		{/if}
	{/snippet}

	{#if oauth.gitlab || oauth.bitbucket}
		<div class="gp-oauth">
			{#if oauth.gitlab}
				<a
					class="gp-oauth-btn gp-oauth-btn--gitlab"
					href={oauthStartUrl('gitlab')}
					data-sveltekit-reload
				>
					<GitBranch size={16} />
					<span>Continue with GitLab</span>
				</a>
			{/if}
			{#if oauth.bitbucket}
				<a
					class="gp-oauth-btn gp-oauth-btn--bitbucket"
					href={oauthStartUrl('bitbucket')}
					data-sveltekit-reload
				>
					<GitBranch size={16} />
					<span>Continue with Bitbucket</span>
				</a>
			{/if}
		</div>
	{/if}

	{#if formOpen}
		<form
			class="gp-form"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<div class="gp-grid">
				<Field label="Provider">
					<Dropdown
						value={provider}
						options={PROVIDERS.map((p) => ({ value: p.kind, label: p.label }))}
						onchange={pickProvider}
					/>
				</Field>
				<Field label="Name" hint="How it shows up when you pick a source">
					<Input bind:value={name} placeholder="work gitlab" />
				</Field>
			</div>
			<Field
				label="Host"
				hint={spec.kind === 'generic'
					? 'Where the repositories live'
					: 'Change it for a self-hosted instance'}
			>
				<Input bind:value={baseUrl} placeholder="https://git.example.com" class="font-mono" />
			</Field>
			<div class="gp-grid">
				{#if spec.needsUsername}
					<Field label="Username">
						<Input bind:value={username} placeholder="username" />
					</Field>
				{/if}
				<Field label="Token" hint={spec.tokenHint}>
					<Input bind:value={token} type="password" placeholder="token" class="font-mono" />
				</Field>
			</div>
			<div class="gp-form-actions">
				<Button variant="ghost" type="button" onclick={() => (formOpen = false)}>Cancel</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={saving || !name.trim() || !token.trim() || !baseUrl.trim()}
				>
					{#if saving}<Loader2 class="h-4 w-4 animate-spin" data-motion="progress" />{/if}
					<span>Connect</span>
				</Button>
			</div>
		</form>
	{/if}

	{#if !loaded}
		<div class="gp-empty"><Loader2 class="h-4 w-4 animate-spin" data-motion="progress" /></div>
	{:else if connections.length === 0 && !formOpen}
		<p class="gp-empty">
			Your token, your repos. Apps you start from a provider build with it, and its webhook
			auto-deploys them.
		</p>
	{:else}
		<ul class="gp-list">
			{#each connections as c, i (c.id)}
				<li class="gp-row" {@attach motionStagger({ index: i, from: { y: 4 } })}>
					<span class="gp-tile" aria-hidden="true"><GitBranch size={15} /></span>
					<div class="gp-main">
						<span class="gp-title">
							<span class="gp-name">{c.name}</span>
							<span class="gp-kind"
								>{providerLabel(c.provider)}{#if c.oauth}
									· signed in{/if}</span
							>
						</span>
						<span class="gp-host"
							>{c.host}{#if c.dependents > 0}
								· {c.dependents} app{c.dependents === 1 ? '' : 's'}{/if}</span
						>
						<div class="gp-webhook">
							<span class="gp-webhook-label">Webhook</span>
							<button
								type="button"
								class="gp-copy"
								onclick={() => copy(`url-${c.id}`, `${apiBase}${c.webhookPath}`)}
								title="Copy webhook URL"
							>
								<Chip mono>{apiBase}{c.webhookPath}</Chip>
								{#if copied === `url-${c.id}`}<Check size={12} />{:else}<Copy size={12} />{/if}
							</button>
							{#if isOwner}
								{#if secrets[c.id]}
									<button
										type="button"
										class="gp-copy"
										onclick={() => copy(`secret-${c.id}`, secrets[c.id])}
										title="Copy secret"
									>
										<Chip mono>{secrets[c.id]}</Chip>
										{#if copied === `secret-${c.id}`}<Check size={12} />{:else}<Copy
												size={12}
											/>{/if}
									</button>
								{:else}
									<button type="button" class="gp-reveal" onclick={() => reveal(c)}>
										<Eye size={12} />
										<span>Show secret</span>
									</button>
								{/if}
							{/if}
						</div>
					</div>
					{#if isOwner}
						<button
							type="button"
							class="gp-remove"
							onclick={() => remove(c)}
							disabled={busyId === c.id}
							aria-label="Remove {c.name}"
						>
							<Trash2 size={14} />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</SettingsSection>

<style>
	.gp-empty {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.gp-oauth {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.gp-oauth-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		border-radius: var(--radius-md);
		font-size: var(--text-callout);
		font-weight: 600;
		color: var(--text-on-accent);
		text-decoration: none;
		background: var(--text-default);
	}
	.gp-oauth-btn--gitlab {
		background: var(--hue-violet, var(--accent));
	}
	.gp-oauth-btn--bitbucket {
		background: var(--hue-blue, var(--accent));
	}
	.gp-oauth-btn:hover {
		filter: brightness(1.08);
	}
	.gp-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--bg-raised);
		box-shadow: inset 0 0 0 1px var(--rule);
	}
	.gp-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}
	.gp-form-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	.gp-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.gp-row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--rule);
	}
	.gp-row:first-child {
		border-top: none;
		padding-top: 0;
	}
	.gp-tile {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		flex-shrink: 0;
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
	}
	.gp-main {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		flex: 1;
	}
	.gp-title {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.gp-name {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
	}
	.gp-kind {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
	.gp-host {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.gp-webhook {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-top: 0.25rem;
	}
	.gp-webhook-label {
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
	.gp-copy,
	.gp-reveal {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		color: var(--text-faint);
		font-size: var(--text-caption);
	}
	.gp-copy:hover,
	.gp-reveal:hover {
		color: var(--text-muted);
	}
	.gp-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.875rem;
		height: 1.875rem;
		border-radius: var(--radius-md);
		border: 0;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
	}
	.gp-remove:hover {
		background: var(--fill-quiet);
		color: var(--status-error);
	}
	.gp-remove:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
