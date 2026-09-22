<script lang="ts">
	import { animate } from 'motion';
	import { tick } from 'svelte';
	import {
		Server,
		FileText,
		Users,
		KeyRound,
		ExternalLink,
		Plus,
		SlidersHorizontal
	} from 'lucide-svelte';
	import { springPop } from '$lib/utils/motion.svelte';
	import { SpatialMenu } from 'melt/builders';
	import { EnvironmentSwitcher } from '$lib/components/environment';

	let {
		activeTab = $bindable('resources'),
		showSettings = false,
		resourceCount = 0,
		composeCount = 0,
		membersCount = 0,
		repositoryUrl,
		hasDeployments = false,
		deploymentSearch = $bindable(''),
		onNewResource,
		tabsRowEl = $bindable<HTMLElement | null>(null),
		deploymentMenu,
		projectId = '',
		selectedEnvId = $bindable('')
	}: {
		activeTab?: 'resources' | 'variables' | 'compose' | 'members' | 'settings';
		showSettings?: boolean;
		resourceCount?: number;
		composeCount?: number;
		membersCount?: number;
		repositoryUrl?: string;
		hasDeployments?: boolean;
		deploymentSearch?: string;
		onNewResource?: () => void;
		tabsRowEl?: HTMLElement | null;
		deploymentMenu: any;
		projectId?: string;
		selectedEnvId?: string;
	} = $props();
</script>

<div class="pj-tabs-row pj-glass" bind:this={tabsRowEl}>
	{#if projectId}
		<div class="pj-env-context">
			<EnvironmentSwitcher {projectId} bind:selectedEnvId />
		</div>
		<div class="pj-env-divider"></div>
	{/if}
	<div class="pj-tabs" role="tablist">
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'resources'}
			class="pj-tab"
			class:is-active={activeTab === 'resources'}
			onclick={() => (activeTab = 'resources')}
			{@attach springPop(() => activeTab === 'resources')}
		>
			<Server class="h-3.5 w-3.5" />
			Apps
			{#if resourceCount > 0}<span class="pj-tab-count">{resourceCount}</span>{/if}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'variables'}
			class="pj-tab"
			class:is-active={activeTab === 'variables'}
			onclick={() => (activeTab = 'variables')}
			{@attach springPop(() => activeTab === 'variables')}
		>
			<KeyRound class="h-3.5 w-3.5" />
			Variables
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'compose'}
			class="pj-tab"
			class:is-active={activeTab === 'compose'}
			onclick={() => (activeTab = 'compose')}
			{@attach springPop(() => activeTab === 'compose')}
		>
			<FileText class="h-3.5 w-3.5" />
			Compose
			{#if composeCount > 0}<span class="pj-tab-count">{composeCount}</span>{/if}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'members'}
			class="pj-tab"
			class:is-active={activeTab === 'members'}
			onclick={() => (activeTab = 'members')}
			{@attach springPop(() => activeTab === 'members')}
		>
			<Users class="h-3.5 w-3.5" />
			Members
			{#if membersCount > 0}<span class="pj-tab-count">{membersCount}</span>{/if}
		</button>
		{#if showSettings}
			<button
				type="button"
				role="tab"
				aria-selected={activeTab === 'settings'}
				class="pj-tab"
				class:is-active={activeTab === 'settings'}
				onclick={() => (activeTab = 'settings')}
				{@attach springPop(() => activeTab === 'settings')}
			>
				<SlidersHorizontal class="h-3.5 w-3.5" />
				Settings
			</button>
		{/if}
	</div>
	<div class="pj-tabs-actions">
		{#if repositoryUrl}
			<a
				href={repositoryUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="pj-tab-chip"
				title="Open repository"
			>
				<ExternalLink class="h-3.5 w-3.5" />
				<span>Repo</span>
			</a>
		{/if}
		{#if activeTab === 'resources'}
			<button class="pj-btn pj-btn-primary pj-btn--sm" onclick={onNewResource}>
				<Plus class="h-4 w-4" />
				New
			</button>
		{/if}
	</div>
</div>
