<script lang="ts">
	import { Loader2, Github, Building2, ExternalLink } from 'lucide-svelte';
	import { Plus } from '@jis3r/icons';
	import { Alert, Button, StatusBadge, statusMeta } from '$lib/components/ui';
	import SettingsSection from './SettingsSection.svelte';
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
		githubTokenExpired = false,
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
		githubTokenExpired?: boolean;
		unlinking: boolean;
		onLink: () => void;
		onUnlink: () => void;
		index?: number;
	} = $props();
</script>

<SettingsSection {index} title="GitHub" description="Deploy from your repositories">
	{#snippet icon(_hovered)}<Github class="h-[18px] w-[18px]" />{/snippet}
	{#snippet badge()}
		{#if !loading}
			<StatusBadge
				meta={statusMeta(
					githubLinked ? 'success' : 'neutral',
					githubLinked ? 'Connected' : 'Not connected'
				)}
			/>
		{/if}
	{/snippet}

	{#if loading}
		<div class="ug-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if !githubLinked}
		<ConnectPrompt label="Connect GitHub" onclick={onLink}>
			{#snippet icon()}<Github class="h-5 w-5" />{/snippet}
		</ConnectPrompt>
	{:else}
		<IntegrationCard name="@{githubUsername}" disconnecting={unlinking} onDisconnect={onUnlink}>
			{#snippet icon()}<Github class="h-4 w-4" />{/snippet}
		</IntegrationCard>

		{#if githubTokenExpired}
			<div class="ug-expired">
				<Alert tone="warning" title="GitHub session expired">
					<div class="ug-expired-body">
						<span class="ug-expired-hint">
							Reconnect to view repository access and deploy from your repositories.
						</span>
						<Button variant="primary" size="sm" onclick={onLink}>Reconnect</Button>
					</div>
				</Alert>
			</div>
		{/if}

		{#if !githubTokenExpired && (githubInstallations.length > 0 || githubAppInstallUrl)}
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
						{#each githubInstallations as inst (inst.id)}
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
		padding: var(--space-6) 0;
		color: var(--text-muted);
	}
	.ug-expired {
		margin-top: var(--space-3);
	}
	.ug-expired-body {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.ug-expired-hint {
		flex: 1;
		min-width: 0;
		color: var(--text-muted);
	}
	.ug-expired :global(.btn) {
		flex-shrink: 0;
	}
	.ug-repos {
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: 1px dashed var(--rule);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.ug-repos-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.ug-repos-title {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
	}
	.ug-repos-meta {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.ug-install-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.ug-install {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background-color: var(--bg-surface);
		text-decoration: none;
		color: var(--text-default);
		transition:
			border-color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.ug-install:hover {
		border-color: color-mix(in srgb, var(--accent) 60%, var(--border-default));
		background-color: var(--bg-hover);
	}
	.ug-install-icon {
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		background-color: var(--fill-soft);
		color: var(--text-default);
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
		gap: var(--space-2);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
	}
	.ug-install-type {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		padding: 0.0625rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--fill-medium);
		color: var(--text-muted);
	}
	.ug-install-meta {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.ug-install-action {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		flex-shrink: 0;
	}
	.ug-install:hover .ug-install-action {
		color: var(--accent);
	}
	.ug-add-link {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		align-self: flex-start;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		text-decoration: none;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}
	.ug-add-link:hover {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}
	.ug-add-link--primary {
		color: var(--text-default);
		background-color: var(--fill-quiet);
		border: 1px dashed color-mix(in srgb, var(--border-default) 80%, transparent);
		padding: 0.625rem var(--space-3);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		width: 100%;
		justify-content: center;
	}
	@media (max-width: 640px) {
		.ug-expired-body {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
