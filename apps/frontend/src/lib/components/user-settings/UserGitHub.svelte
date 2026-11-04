<script lang="ts">
	import { Building2, ExternalLink, GitBranch, Plus } from 'lucide-svelte';
	import {
		Button,
		Field,
		Input,
		List,
		ListRow,
		Modal,
		ModalIntro,
		SectionCard,
		Skeleton,
		ToneTile
	} from '$lib/components/ui';
	import GitHostMark from '$lib/components/ui/GitHostMark.svelte';
	import { createGithubApp, installationSettingsUrl } from '$lib/queries/github';
	import { isSuperAdmin, toasts } from '$lib/stores';

	interface GitHubInstallation {
		id: string;
		installationId: string;
		accountLogin: string;
		accountType: string;
		repositorySelection: string;
	}

	let {
		loading,
		githubLinked,
		githubUsername,
		githubInstallations,
		githubAppInstallUrl,
		githubTokenExpired = false,
		appConfigured = true,
		unlinking,
		onLink,
		onUnlink
	}: {
		loading: boolean;
		githubLinked: boolean;
		githubUsername: string | null;
		githubInstallations: GitHubInstallation[];
		githubAppInstallUrl: string | null;
		githubTokenExpired?: boolean;
		appConfigured?: boolean;
		unlinking: boolean;
		onLink: () => void;
		onUnlink: () => void;
		index?: number;
	} = $props();

	const uid = $props.id();
	let showSetup = $state(false);
	let organization = $state('');
	let creating = $state(false);

	async function createApp() {
		creating = true;
		try {
			await createGithubApp(organization, '/user/settings');
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't create the GitHub App",
				color: 'error'
			});
			creating = false;
		}
	}

	const showAccess = $derived(
		githubLinked && !githubTokenExpired && (githubInstallations.length > 0 || !!githubAppInstallUrl)
	);
</script>

<SectionCard
	title="GitHub"
	description={!loading && !githubLinked && !appConfigured && !$isSuperAdmin
		? 'An instance admin needs to set up GitHub first'
		: 'Deploy from your repositories'}
>
	{#snippet actions()}
		{#if !loading && !githubLinked}
			{#if appConfigured}
				<Button size="sm" variant="primary" onclick={onLink}>Connect</Button>
			{:else if $isSuperAdmin}
				<Button size="sm" variant="primary" onclick={() => (showSetup = true)}>Set up</Button>
			{/if}
		{/if}
	{/snippet}
	{#if loading}
		<div class="placeholder"><Skeleton height="2.5rem" /></div>
	{:else if githubLinked}
		<List inset={false} label="GitHub account">
			<ListRow
				flush
				pinned
				title="@{githubUsername}"
				subtitle={githubTokenExpired
					? 'Session expired, reconnect to see your repositories'
					: undefined}
			>
				{#snippet leading()}
					<ToneTile size={32} tone={githubTokenExpired ? 'warning' : 'neutral'}>
						<GitHostMark host="github" />
					</ToneTile>
				{/snippet}
				{#snippet actions()}
					{#if githubTokenExpired}
						<Button size="sm" variant="primary" onclick={onLink}>Reconnect</Button>
					{/if}
					<Button size="sm" variant="ghost" loading={unlinking} onclick={onUnlink}
						>Disconnect</Button
					>
				{/snippet}
			</ListRow>
		</List>
	{/if}
</SectionCard>

<Modal bind:open={showSetup} size="md" closable={false} dismissable labelledby="{uid}-title">
	<form
		id="{uid}-form"
		class="setup-form"
		onsubmit={(e) => {
			e.preventDefault();
			createApp();
		}}
	>
		<ModalIntro
			id="{uid}-title"
			icon={GitBranch}
			tone="accent"
			title="Set up GitHub"
			description="This instance has no GitHub App yet. Create one in one click, then connect your account."
		/>
		<Field
			label="GitHub organization"
			for="{uid}-org"
			hint="Leave it blank to create the App on your personal account."
		>
			<Input id="{uid}-org" bind:value={organization} autocomplete="off" spellcheck="false" />
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" shape="capsule" disabled={creating} onclick={() => (showSetup = false)}>
			Cancel
		</Button>
		<Button variant="primary" shape="capsule" type="submit" form="{uid}-form" loading={creating}>
			Create GitHub App
		</Button>
	{/snippet}
</Modal>

{#if !loading && showAccess}
	<SectionCard
		title="Repository access"
		description={githubInstallations.length === 0
			? 'Pick the accounts and organizations Orchard can deploy from'
			: undefined}
	>
		{#snippet actions()}
			{#if githubAppInstallUrl}
				<Button
					size="sm"
					icon={Plus}
					href={githubAppInstallUrl}
					target="_blank"
					rel="noopener noreferrer">Add account</Button
				>
			{/if}
		{/snippet}
		{#if githubInstallations.length > 0}
			<List inset={false} label="GitHub accounts">
				{#each githubInstallations as inst (inst.id)}
					{@const isOrg = inst.accountType === 'Organization'}
					<ListRow
						flush
						title={inst.accountLogin}
						subtitle="{isOrg ? 'Organization' : 'Personal account'} · {inst.repositorySelection ===
						'all'
							? 'all repositories'
							: 'selected repositories'}"
					>
						{#snippet leading()}
							<ToneTile size={32}>
								{#if isOrg}<Building2 size={16} />{:else}<GitHostMark host="github" />{/if}
							</ToneTile>
						{/snippet}
						{#snippet actions()}
							<Button
								size="sm"
								variant="ghost"
								iconRight={ExternalLink}
								href={installationSettingsUrl(inst)}
								target="_blank"
								rel="noopener noreferrer">Manage</Button
							>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</SectionCard>
{/if}

<style>
	.setup-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.placeholder {
		display: flex;
		flex-direction: column;
	}
</style>
