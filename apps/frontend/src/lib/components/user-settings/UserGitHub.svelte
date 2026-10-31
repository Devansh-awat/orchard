<script lang="ts">
	import { Building2, ExternalLink, Plus } from 'lucide-svelte';
	import { Button, List, ListRow, SectionCard, Skeleton, ToneTile } from '$lib/components/ui';
	import GitHostMark from '$lib/components/ui/GitHostMark.svelte';

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
		unlinking: boolean;
		onLink: () => void;
		onUnlink: () => void;
		index?: number;
	} = $props();

	const showAccess = $derived(
		githubLinked && !githubTokenExpired && (githubInstallations.length > 0 || !!githubAppInstallUrl)
	);

	function manageUrl(inst: GitHubInstallation) {
		return inst.accountType === 'Organization'
			? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
			: `https://github.com/settings/installations/${inst.installationId}`;
	}
</script>

<SectionCard title="GitHub" description="Deploy from your repositories">
	{#snippet actions()}
		{#if !loading && !githubLinked}
			<Button size="sm" variant="primary" onclick={onLink}>Connect</Button>
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
				subtitle={githubTokenExpired ? 'Session expired, reconnect to see your repositories' : undefined}
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
					<Button size="sm" variant="ghost" loading={unlinking} onclick={onUnlink}>Disconnect</Button>
				{/snippet}
			</ListRow>
		</List>
	{/if}
</SectionCard>

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
								href={manageUrl(inst)}
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
	.placeholder {
		display: flex;
		flex-direction: column;
	}
</style>
