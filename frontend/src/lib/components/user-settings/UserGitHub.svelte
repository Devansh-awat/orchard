<script lang="ts">
	import { Loader2, Github, Building2, ExternalLink } from 'lucide-svelte';
	import { Plus } from '@jis3r/icons';
	import SettingsSection from './SettingsSection.svelte';
	import StatusPill from './StatusPill.svelte';
	import IntegrationCard from './IntegrationCard.svelte';
	import ConnectPrompt from './ConnectPrompt.svelte';

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
		index = 0
	}: {
		loading: boolean;
		githubLinked: boolean;
		githubUsername: string | null;
		githubInstallations: GitHubInstallation[];
		githubAppInstallUrl: string | null;
		unlinking: boolean;
		onLink: () => void;
		onUnlink: () => void;
		index?: number;
	} = $props();
</script>

<SettingsSection {index} title="GitHub" description="Connect to deploy from your repositories">
	{#snippet icon(_hovered)}<Github class="h-[18px] w-[18px]" />{/snippet}
	{#snippet badge()}
		{#if !loading}
			<StatusPill active={githubLinked} label={githubLinked ? 'Connected' : 'Not connected'} />
		{/if}
	{/snippet}

	{#if loading}
		<div class="ug-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if !githubLinked}
		<ConnectPrompt
			label="Sign in with GitHub"
			hint="We verify your identity to confirm which repositories you can deploy. No extra scopes requested."
			onclick={onLink}
		>
			{#snippet icon()}<Github class="h-5 w-5" />{/snippet}
		</ConnectPrompt>
	{:else}
		<IntegrationCard name="@{githubUsername}" disconnecting={unlinking} onDisconnect={onUnlink}>
			{#snippet icon()}<Github class="h-4 w-4" />{/snippet}
		</IntegrationCard>

		{#if githubInstallations.length > 0 || githubAppInstallUrl}
			<div class="ug-repos">
				<div class="ug-repos-head">
					<span class="ug-repos-title">Repository access</span>
					{#if githubInstallations.length > 0}
						<span class="ug-repos-meta">
							{githubInstallations.length}
							{githubInstallations.length === 1 ? 'account' : 'accounts'} connected
						</span>
					{:else}
						<span class="ug-repos-meta">None yet</span>
					{/if}
				</div>

				{#if githubInstallations.length > 0}
					<div class="ug-install-list">
						{#each githubInstallations as inst}
							{@const isOrg = inst.accountType === 'Organization'}
							{@const manageUrl = isOrg
								? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
								: `https://github.com/settings/installations/${inst.installationId}`}
							<a href={manageUrl} target="_blank" rel="noopener noreferrer" class="ug-install">
								<div class="ug-install-icon">
									{#if isOrg}<Building2 class="h-4 w-4" />{:else}<Github class="h-4 w-4" />{/if}
								</div>
								<div class="ug-install-info">
									<span class="ug-install-name">
										{inst.accountLogin}
										<span class="ug-install-type">{isOrg ? 'Organization' : 'User'}</span>
									</span>
									<span class="ug-install-meta">
										{inst.repositorySelection === 'all'
											? 'All repositories'
											: 'Selected repositories'}
									</span>
								</div>
								<span class="ug-install-action">
									Manage <ExternalLink class="h-3 w-3" />
								</span>
							</a>
						{/each}
					</div>
				{/if}

				{#if githubAppInstallUrl}
					<a
						href={githubAppInstallUrl}
						target="_blank"
						class="ug-add-link"
						class:ug-add-link--primary={githubInstallations.length === 0}
					>
						<Plus size={16} />
						{githubInstallations.length > 0
							? 'Add another organization or account'
							: 'Connect a repository or organization'}
					</a>
				{/if}
			</div>
		{/if}
	{/if}
</SettingsSection>

<style>
	.ug-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--surface-muted);
	}
	.ug-repos {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px dashed color-mix(in srgb, var(--surface-border) 70%, transparent);
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.ug-repos-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.ug-repos-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.ug-repos-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}
	.ug-install-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.ug-install {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.875rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		text-decoration: none;
		color: var(--center-channel-color);
		transition:
			border-color 0.15s,
			background-color 0.15s;
	}
	.ug-install:hover {
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 60%, var(--surface-border));
		background-color: color-mix(in srgb, var(--surface-border) 25%, var(--surface-bg));
	}
	.ug-install-icon {
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
	}
	.ug-install-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.ug-install-name {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.ug-install-type {
		font-size: 0.625rem;
		font-weight: 500;
		padding: 0.0625rem 0.375rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.ug-install-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}
	.ug-install-action {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--surface-muted);
		flex-shrink: 0;
	}
	.ug-install:hover .ug-install-action {
		color: var(--sidebar-text-active-border);
	}
	.ug-add-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		align-self: flex-start;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		text-decoration: none;
		transition:
			background-color 0.15s,
			color 0.15s;
	}
	.ug-add-link:hover {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		color: var(--center-channel-color);
	}
	.ug-add-link--primary {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 4%, transparent);
		border: 1px dashed color-mix(in srgb, var(--surface-border) 80%, transparent);
		padding: 0.625rem 0.75rem;
		font-size: 0.8125rem;
		width: 100%;
		justify-content: center;
	}
</style>
