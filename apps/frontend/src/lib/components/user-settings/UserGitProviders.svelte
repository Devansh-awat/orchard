<script lang="ts">
	import { Ellipsis, GitBranch, KeyRound, Link, Plus, Trash2 } from 'lucide-svelte';
	import {
		Button,
		Dropdown,
		Field,
		FieldGrid,
		Input,
		List,
		ListRow,
		Menu,
		MenuItem,
		MenuSeparator,
		Modal,
		ModalIntro,
		SecretInput,
		SectionCard,
		ToneTile
	} from '$lib/components/ui';
	import GitHostMark, { gitHostOf } from '$lib/components/ui/GitHostMark.svelte';
	import { toasts } from '$lib/stores';
	import { env } from '$env/dynamic/public';
	import {
		PROVIDERS,
		createGitConnection,
		deleteGitConnection,
		fetchGitConnections,
		fetchOauthAvailability,
		fetchWebhookSecret,
		isBitbucketAppPassword,
		oauthStartUrl,
		type OauthAvailability,
		type GitConnection,
		type GitProviderKind
	} from './git-connections';

	let { index: _index = 0 }: { index?: number } = $props();

	const uid = $props.id();

	let connections = $state<GitConnection[]>([]);
	let oauth = $state<OauthAvailability>({ gitlab: null, bitbucket: null });
	let loaded = $state(false);
	let formOpen = $state(false);
	let saving = $state(false);
	let busyId = $state<string | null>(null);

	let provider = $state<GitProviderKind>('gitlab');
	let name = $state('');
	let baseUrl = $state(PROVIDERS[0].baseUrl);
	let username = $state('');
	let token = $state('');

	const spec = $derived(PROVIDERS.find((p) => p.kind === provider) ?? PROVIDERS[0]);
	const apiBase = $derived(
		env.PUBLIC_PLATFORM_ORIGIN ||
			(env.PUBLIC_BASE_DOMAIN ? `https://${env.PUBLIC_BASE_DOMAIN}` : '')
	);
	const hasOauth = $derived(!!oauth.gitlab || !!oauth.bitbucket);
	const canSave = $derived(!!name.trim() && !!token.trim() && !!baseUrl.trim());

	async function load() {
		try {
			[connections, oauth] = await Promise.all([fetchGitConnections(), fetchOauthAvailability()]);
		} catch (e) {
			toasts.add({
				title: "Couldn't load git providers",
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
		if (!canSave || saving) return;
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
				title: "Couldn't connect",
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

	async function copy(text: string, title: string) {
		try {
			await navigator.clipboard.writeText(text);
			toasts.add({ title, color: 'success' });
		} catch {
			toasts.add({ title: text, color: 'info' });
		}
	}

	async function copySecret(c: GitConnection) {
		try {
			await copy(await fetchWebhookSecret(c.id), 'Webhook secret copied');
		} catch (e) {
			toasts.add({
				title: "Couldn't load the secret",
				description: e instanceof Error ? e.message : '',
				color: 'error'
			});
		}
	}

	function detail(c: GitConnection) {
		const parts = [c.host];
		if (c.oauth) parts.push('signed in');
		if (isBitbucketAppPassword(c)) parts.push('app password, reconnect with an API token');
		if (c.dependents > 0) parts.push(`${c.dependents} app${c.dependents === 1 ? '' : 's'}`);
		return parts.join(' · ');
	}
</script>

{#snippet tokenHint()}
	{spec.tokenHint}
	{#if spec.tokenLink}
		<a href={spec.tokenLink.href} target="_blank" rel="noopener noreferrer"
			>{spec.tokenLink.label}</a
		>
	{/if}
{/snippet}

{#snippet providerMark(kind: string)}
	<GitHostMark host={gitHostOf(kind)} />
{/snippet}

<SectionCard
	title="Git providers"
	description="Deploy from GitLab, Gitea, Codeberg, Bitbucket or any git host"
>
	{#snippet actions()}
		{#if hasOauth}
			<Menu placement="bottom-end">
				{#snippet trigger(props)}
					<Button {...props} size="sm" icon={Plus}>Add provider</Button>
				{/snippet}
				{#if oauth.gitlab}
					<MenuItem href={oauthStartUrl('gitlab')} data-sveltekit-reload plain>
						{#snippet leading()}<GitHostMark host="gitlab" />{/snippet}
						Sign in with GitLab
					</MenuItem>
				{/if}
				{#if oauth.bitbucket}
					<MenuItem href={oauthStartUrl('bitbucket')} data-sveltekit-reload plain>
						{#snippet leading()}<GitHostMark host="bitbucket" />{/snippet}
						Sign in with Bitbucket
					</MenuItem>
				{/if}
				<MenuSeparator />
				<MenuItem icon={KeyRound} onclick={openForm}>Add with a token</MenuItem>
			</Menu>
		{:else}
			<Button size="sm" icon={Plus} onclick={openForm}>Add with a token</Button>
		{/if}
	{/snippet}

	{#if loaded && connections.length > 0}
		<List inset={false} label="Git providers">
			{#each connections as c (c.id)}
				<ListRow flush pinned presence title={c.name} subtitle={detail(c)}>
					{#snippet leading()}
						<ToneTile size={32}><GitHostMark host={gitHostOf(c.provider, c.host)} /></ToneTile>
					{/snippet}
					{#snippet actions()}
						<Menu placement="bottom-end">
							{#snippet trigger(props)}
								<Button
									{...props}
									size="sm"
									variant="ghost"
									icon={Ellipsis}
									loading={busyId === c.id}
									label="{c.name} actions"
								/>
							{/snippet}
							<MenuItem
								icon={Link}
								onclick={() => copy(`${apiBase}${c.webhookPath}`, 'Webhook URL copied')}
								>Copy webhook URL</MenuItem
							>
							<MenuItem icon={KeyRound} onclick={() => copySecret(c)}>Copy webhook secret</MenuItem>
							<MenuSeparator />
							<MenuItem icon={Trash2} danger onclick={() => remove(c)}>Remove</MenuItem>
						</Menu>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</SectionCard>

<Modal bind:open={formOpen} size="md" closable={false} dismissable labelledby="{uid}-title">
	<form
		id="{uid}-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		<ModalIntro id="{uid}-title" icon={GitBranch} tone="accent" title="Add a git provider" />
		<FieldGrid>
			<Field label="Provider">
				<Dropdown
					value={provider}
					options={PROVIDERS.map((p) => ({ value: p.kind, label: p.label }))}
					icon={providerMark}
					onchange={pickProvider}
				/>
			</Field>
			<Field label="Name" for="{uid}-name" hint="Shown when you pick a source">
				<Input id="{uid}-name" bind:value={name} placeholder="work gitlab" />
			</Field>
		</FieldGrid>
		<Field
			label="Host"
			for="{uid}-host"
			hint={spec.kind === 'generic'
				? 'Where the repositories live'
				: 'Change it for a self-hosted instance'}
		>
			<Input id="{uid}-host" bind:value={baseUrl} placeholder="https://git.example.com" mono />
		</Field>
		<FieldGrid>
			{#if spec.needsUsername}
				<Field label={spec.usernameLabel ?? 'Username'} for="{uid}-user" hint={spec.usernameHint}>
					<Input
						id="{uid}-user"
						bind:value={username}
						placeholder={spec.usernamePlaceholder ?? 'username'}
					/>
				</Field>
			{/if}
			<Field label={spec.tokenLabel ?? 'Token'} for="{uid}-token" hint={tokenHint}>
				<SecretInput id="{uid}-token" bind:value={token} placeholder="token" />
			</Field>
		</FieldGrid>
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={saving} onclick={() => (formOpen = false)}>Cancel</Button>
		<Button variant="primary" type="submit" form="{uid}-form" loading={saving} disabled={!canSave}
			>Connect</Button
		>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
