<script lang="ts">
	import { animate } from 'motion';
	import { tick } from 'svelte';
	import { Server, FileText, Users, ExternalLink, Plus } from 'lucide-svelte';
	import { springPop } from '$lib/utils/motion.svelte';
	import { SpatialMenu } from 'melt/builders';

	let {
		activeTab = $bindable('resources'),
		resourceCount = 0,
		composeCount = 0,
		membersCount = 0,
		repositoryUrl,
		hasDeployments = false,
		deploymentSearch = $bindable(''),
		onNewResource,
		tabsRowEl = $bindable<HTMLElement | null>(null),
		deploymentMenu,
	}: {
		activeTab?: 'resources' | 'compose' | 'members';
		resourceCount?: number;
		composeCount?: number;
		membersCount?: number;
		repositoryUrl?: string;
		hasDeployments?: boolean;
		deploymentSearch?: string;
		onNewResource?: () => void;
		tabsRowEl?: HTMLElement | null;
		deploymentMenu: any;
	} = $props();
</script>

<div class="pj-tabs-row" bind:this={tabsRowEl}>
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
			Resources
			<span class="pj-tab-count">{resourceCount}</span>
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
			<span class="pj-tab-count">{composeCount}</span>
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
			<span class="pj-tab-count">{membersCount}</span>
		</button>
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
			{#if hasDeployments}
				<div class="pj-deployment-search-bar" {...deploymentMenu.root}>
					<input
						type="search"
						placeholder="Search…"
						class="pj-search-input"
						bind:value={deploymentSearch}
						{...deploymentMenu.input}
					/>
				</div>
			{/if}
			<button
				class="pj-btn pj-btn-primary pj-btn--sm"
				onclick={onNewResource}
			>
				<Plus class="h-4 w-4" />
				New
			</button>
		{/if}
	</div>
</div>
