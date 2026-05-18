<script lang="ts">
	import { Loader2, Github, Unlink, ChevronRight, Plus, Building2, ExternalLink } from 'lucide-svelte';

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
		unlinking,
		onLink,
		onUnlink,
	}: {
		loading: boolean;
		githubLinked: boolean;
		githubUsername: string | null;
		githubInstallations: GitHubInstallation[];
		githubAppInstallUrl: string | null;
		unlinking: boolean;
		onLink: () => void;
		onUnlink: () => void;
	} = $props();
</script>

<div class="us-card-section">
	<div class="us-section-head">
		<div class="us-section-icon us-section-icon--github">
			<Github class="h-4 w-4" />
		</div>
		<div class="us-section-title-group">
			<h2 class="us-section-title">GitHub</h2>
			<p class="us-section-desc">Connect to deploy from your repositories</p>
		</div>
		{#if !loading}
			<div class="us-pill" class:us-pill--active={githubLinked}>
				<span class="us-pill-dot"></span>
				{githubLinked ? 'Connected' : 'Not connected'}
			</div>
		{/if}
	</div>

	{#if loading}
		<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if !githubLinked}
		<button onclick={onLink} class="us-connect-btn">
			<div class="us-connect-icon">
				<Github class="h-5 w-5" />
			</div>
			<div class="us-connect-text">
				<span class="us-connect-label">Sign in with GitHub</span>
				<span class="us-connect-hint">We verify your identity to confirm which repositories you can deploy. No extra scopes requested.</span>
			</div>
			<ChevronRight class="h-4 w-4 us-connect-arrow" />
		</button>
	{:else}
		<div class="us-integration-row">
			<div class="us-gh-badge">
				<Github class="h-4 w-4" />
				<span class="us-gh-name">@{githubUsername}</span>
			</div>
			<button onclick={onUnlink} disabled={unlinking} class="us-btn us-btn-danger">
				{#if unlinking}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Unlink class="h-3.5 w-3.5" />{/if}
				Disconnect
			</button>
		</div>

		<div class="us-subsection">
			<div class="us-subsection-head">
				<span class="us-subsection-title">Repository access</span>
				{#if githubInstallations.length > 0}
					<span class="us-subsection-meta">
						{githubInstallations.length} {githubInstallations.length === 1 ? 'account' : 'accounts'} connected
					</span>
				{:else}
					<span class="us-subsection-meta">None yet</span>
				{/if}
			</div>

			{#if githubInstallations.length > 0}
				<div class="us-install-list">
					{#each githubInstallations as inst}
						{@const isOrg = inst.accountType === 'Organization'}
						{@const manageUrl = isOrg
							? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
							: `https://github.com/settings/installations/${inst.installationId}`}
						<a
							href={manageUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="us-install-card"
						>
							<div class="us-install-avatar">
								{#if isOrg}
									<Building2 class="h-4 w-4" />
								{:else}
									<Github class="h-4 w-4" />
								{/if}
							</div>
							<div class="us-install-info">
								<span class="us-install-name">
									{inst.accountLogin}
									<span class="us-install-type">{isOrg ? 'Organization' : 'User'}</span>
								</span>
								<span class="us-install-meta">
									{inst.repositorySelection === 'all' ? 'All repositories' : 'Selected repositories'}
								</span>
							</div>
							<span class="us-install-action">
								Manage on GitHub
								<ExternalLink class="h-3 w-3" />
							</span>
						</a>
					{/each}
				</div>
			{/if}

			{#if githubAppInstallUrl}
				<a
					href={githubAppInstallUrl}
					target="_blank"
					class="us-add-link"
					class:us-add-link--primary={githubInstallations.length === 0}
				>
					<Plus class="h-4 w-4" />
					{githubInstallations.length > 0 ? 'Add another organization or account' : 'Connect a repository or organization'}
				</a>
			{/if}
		</div>
	{/if}
</div>
