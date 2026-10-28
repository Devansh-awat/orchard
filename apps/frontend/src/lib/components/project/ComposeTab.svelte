<script lang="ts">
	import { Ellipsis, ExternalLink, Layers, Plus, RotateCw } from 'lucide-svelte';
	import { useQueryClient } from '@tanstack/svelte-query';
	import {
		Button,
		EmptyState,
		List,
		Menu,
		MenuItem,
		MenuLabel,
		MenuSeparator,
		SectionTitle,
		Skeleton,
		StatusDot,
		resourceStatus
	} from '$lib/components/ui';
	import StackRow from '$lib/components/patterns/StackRow.svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import type { ComposeStackSummary } from './types';

	type Stack = ComposeStackSummary & {
		updatedAt?: string;
		lastError?: string | null;
		buildStatus?: string;
		githubRepo?: string | null;
		githubBranch?: string | null;
		composePath?: string | null;
	};

	let {
		composeStacks,
		composeStacksLoading = false,
		orgSlug,
		projectSlug,
		canEdit = true
	}: {
		composeStacks: Stack[];
		composeStacksLoading?: boolean;
		orgSlug: string;
		projectSlug: string;
		canEdit?: boolean;
	} = $props();

	const queryClient = useQueryClient();
	const newHref = $derived(`/${orgSlug}/projects/${projectSlug}/compose-stacks/new`);
	let redeploying = $state<string | null>(null);

	function repoLabel(url: string) {
		try {
			return new URL(url).pathname.replace(/^\/+|\.git$/g, '');
		} catch {
			return url;
		}
	}

	function source(cs: Stack) {
		if (!cs.githubRepo) return undefined;
		const parts = [repoLabel(cs.githubRepo)];
		if (cs.githubBranch) parts.push(cs.githubBranch);
		if (cs.composePath) parts.push(cs.composePath);
		return parts.join(' · ');
	}

	function services(cs: Stack) {
		return (cs.deployments ?? []).map((d) => ({
			id: d.id,
			name: d.composeServiceName || d.name,
			status: resourceStatus(d.status)
		}));
	}

	async function redeploy(cs: Stack) {
		redeploying = cs.id;
		try {
			const res = await apiFetch(`/apiv1/compose-stacks/${cs.id}/redeploy`, { method: 'POST' });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.message || 'Redeploy failed');
			}
			toasts.add({ title: `Redeploying ${cs.name}`, color: 'success' });
			queryClient.invalidateQueries({ queryKey: ['compose-stacks'] });
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Redeploy failed',
				color: 'error'
			});
		} finally {
			redeploying = null;
		}
	}
</script>

{#if composeStacks.length === 0 && !composeStacksLoading}
	<EmptyState title="No compose stacks" description="Each service in the file becomes its own app.">
		{#snippet icon()}<Layers size={20} />{/snippet}
		{#if canEdit}
			<Button href={newHref} variant="primary" icon={Plus}>Deploy compose file</Button>
		{/if}
	</EmptyState>
{:else}
	<div class="stacks">
		{#if canEdit}
			<SectionTitle title="Stacks">
				{#snippet actions()}
					<Button href={newHref} variant="secondary" size="sm" icon={Plus}>New stack</Button>
				{/snippet}
			</SectionTitle>
		{/if}
		{#if composeStacks.length === 0}
			<Skeleton height="9.75rem" rounded="calc(var(--radius-card) * var(--corner-scale))" />
		{:else}
			<List label="Compose stacks">
				{#each composeStacks as cs (cs.id)}
					<StackRow
						name={cs.name}
						status={resourceStatus(cs.status, cs.buildStatus)}
						services={services(cs)}
						source={source(cs)}
						error={cs.status === 'failed' ? cs.lastError : undefined}
						updatedAt={cs.updatedAt ?? cs.createdAt}
						href="/{orgSlug}/compose-stacks/{cs.id}"
					>
						{#snippet actions()}
							<Menu placement="bottom-end">
								{#snippet trigger(props)}
									<Button {...props} size="sm" variant="ghost" icon={Ellipsis} label="Actions" />
								{/snippet}
								{#if canEdit}
									<MenuItem
										icon={RotateCw}
										disabled={redeploying === cs.id}
										onclick={() => redeploy(cs)}>Redeploy</MenuItem
									>
								{/if}
								{#if cs.githubRepo}
									<MenuItem icon={ExternalLink} href={cs.githubRepo} target="_blank"
										>Open repository</MenuItem
									>
								{/if}
								{#if cs.deployments?.length}
									{#if canEdit || cs.githubRepo}<MenuSeparator />{/if}
									<MenuLabel>Services</MenuLabel>
									{#each services(cs) as s (s.id)}
										<MenuItem href="/{orgSlug}/deployments/{s.id}" plain>
											{#snippet leading()}<span class="service-dot"
													><StatusDot meta={s.status} /></span
												>{/snippet}
											{s.name}
										</MenuItem>
									{/each}
								{/if}
							</Menu>
						{/snippet}
					</StackRow>
				{/each}
			</List>
		{/if}
	</div>
{/if}

<style>
	.service-dot {
		display: inline-flex;
	}
	.stacks {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
</style>
