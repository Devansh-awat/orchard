<script lang="ts">
	import { Ellipsis, LayoutTemplate, Plus } from 'lucide-svelte';
	import {
		Button,
		EmptyState,
		List,
		Menu,
		MenuItem,
		MenuLabel,
		SectionTitle,
		StatusDot,
		resourceStatus
	} from '$lib/components/ui';
	import StackRow, { type StackService } from '$lib/components/patterns/StackRow.svelte';
	import type { DatabaseSummary, Deployment, TemplateInstanceSummary } from './types';

	let {
		instances,
		deployments,
		databases,
		orgSlug,
		projectSlug,
		canEdit = true
	}: {
		instances: TemplateInstanceSummary[];
		deployments: Deployment[];
		databases: DatabaseSummary[];
		orgSlug: string;
		projectSlug: string;
		canEdit?: boolean;
	} = $props();

	const browseHref = $derived(`/${orgSlug}/projects/${projectSlug}/templates`);

	type Resource = StackService & { href: string };

	const resourcesOf = $derived.by(() => {
		const out = new Map<string, Resource[]>();
		const add = (id: string, r: Resource) => {
			const list = out.get(id);
			if (list) list.push(r);
			else out.set(id, [r]);
		};
		for (const d of deployments) {
			if (!d.templateInstanceId) continue;
			add(d.templateInstanceId, {
				id: d.id,
				name: d.displayName || d.name,
				status: resourceStatus(d.status, d.buildStatus),
				href: `/${orgSlug}/deployments/${d.id}`
			});
		}
		for (const db of databases) {
			if (!db.templateInstanceId) continue;
			add(db.templateInstanceId, {
				id: db.id,
				name: db.name,
				status: resourceStatus(db.status),
				href: `/${orgSlug}/databases/${db.id}`
			});
		}
		return out;
	});
</script>

{#if instances.length === 0}
	<EmptyState title="No templates in this project">
		{#snippet icon()}<LayoutTemplate size={20} />{/snippet}
		{#if canEdit}
			<Button href={browseHref} variant="primary" icon={Plus}>Deploy a template</Button>
		{/if}
	</EmptyState>
{:else}
	<div class="templates">
		{#if canEdit}
			<SectionTitle size="md" title="Deployed" count={instances.length}>
				{#snippet actions()}
					<Button href={browseHref} variant="secondary" size="sm" icon={Plus}
						>Deploy a template</Button
					>
				{/snippet}
			</SectionTitle>
		{/if}
		<List label="Templates">
			{#each instances as ti (ti.id)}
				{@const resources = resourcesOf.get(ti.id) ?? []}
				<StackRow
					kind="template"
					image={ti.template.icon ?? null}
					name={ti.name}
					status={resourceStatus(ti.status)}
					services={resources}
					source={ti.template.displayName}
					updatedAt={ti.createdAt}
					href="/{orgSlug}/template-instances/{ti.id}"
				>
					{#snippet actions()}
						{#if resources.length}
							<Menu placement="bottom-end">
								{#snippet trigger(props)}
									<Button {...props} size="sm" variant="ghost" icon={Ellipsis} label="Actions" />
								{/snippet}
								<MenuLabel>Resources</MenuLabel>
								{#each resources as r (r.id)}
									<MenuItem href={r.href} plain>
										{#snippet leading()}<span class="dot"><StatusDot meta={r.status} /></span
											>{/snippet}
										{r.name}
									</MenuItem>
								{/each}
							</Menu>
						{/if}
					{/snippet}
				</StackRow>
			{/each}
		</List>
	</div>
{/if}

<style>
	.dot {
		display: inline-flex;
	}
	.templates {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
</style>
