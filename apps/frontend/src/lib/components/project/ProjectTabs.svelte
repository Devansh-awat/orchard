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
	import type { ProjectTab } from './types';

	let {
		activeTab = 'resources',
		onSelect,
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
		activeTab?: ProjectTab;
		onSelect: (tab: ProjectTab) => void;
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
			onclick={() => onSelect('resources')}
			{@attach springPop(() => activeTab === 'resources')}
		>
			<Server class="h-3.5 w-3.5" />
			<span class="pj-tab-label">Apps</span>
			{#if resourceCount > 0}<span class="pj-tab-count">{resourceCount}</span>{/if}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'variables'}
			class="pj-tab"
			class:is-active={activeTab === 'variables'}
			onclick={() => onSelect('variables')}
			{@attach springPop(() => activeTab === 'variables')}
		>
			<KeyRound class="h-3.5 w-3.5" />
			<span class="pj-tab-label">Variables</span>
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'compose'}
			class="pj-tab"
			class:is-active={activeTab === 'compose'}
			onclick={() => onSelect('compose')}
			{@attach springPop(() => activeTab === 'compose')}
		>
			<FileText class="h-3.5 w-3.5" />
			<span class="pj-tab-label">Compose</span>
			{#if composeCount > 0}<span class="pj-tab-count">{composeCount}</span>{/if}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'members'}
			class="pj-tab"
			class:is-active={activeTab === 'members'}
			onclick={() => onSelect('members')}
			{@attach springPop(() => activeTab === 'members')}
		>
			<Users class="h-3.5 w-3.5" />
			<span class="pj-tab-label">Members</span>
			{#if membersCount > 0}<span class="pj-tab-count">{membersCount}</span>{/if}
		</button>
		{#if showSettings}
			<button
				type="button"
				role="tab"
				aria-selected={activeTab === 'settings'}
				class="pj-tab"
				class:is-active={activeTab === 'settings'}
				onclick={() => onSelect('settings')}
				{@attach springPop(() => activeTab === 'settings')}
			>
				<SlidersHorizontal class="h-3.5 w-3.5" />
				<span class="pj-tab-label">Settings</span>
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
		<button class="pj-btn pj-btn-primary pj-btn--sm" onclick={onNewResource}>
			<Plus class="h-4 w-4" />
			New
		</button>
	</div>
</div>
