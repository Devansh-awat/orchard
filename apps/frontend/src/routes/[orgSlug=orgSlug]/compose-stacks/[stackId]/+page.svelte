<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { apiFetch, toasts, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import {
		Ellipsis,
		ExternalLink,
		GitBranch,
		GitCommitHorizontal,
		Github,
		Pencil,
		RefreshCw,
		Trash2
	} from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import MetaList from '$lib/components/ui/MetaList.svelte';
	import {
		Alert,
		Breadcrumbs,
		Button,
		EmptyState,
		List,
		Menu,
		MenuItem,
		MenuSeparator,
		Page,
		SectionCard,
		SectionTitle,
		Skeleton,
		Stack,
		StatusBadge,
		ToggleRow,
		resourceStatus
	} from '$lib/components/ui';

	interface ChildDeployment {
		id: string;
		name: string;
		status: string;
		image?: string;
		buildStatus?: string;
		composeServiceName?: string;
	}

	interface ComposeStack {
		id: string;
		projectId: string;
		name: string;
		composeYaml: string;
		status: string;
		buildStatus?: string;
		lastError?: string | null;
		githubRepo?: string | null;
		githubBranch?: string | null;
		composePath?: string | null;
		autoDeployEnabled: boolean;
		autoDeployBranch?: string | null;
		lastCommitSha?: string | null;
		deployments: ChildDeployment[];
	}

	let stack = $state<ComposeStack | null>(null);
	let project = $state<{ name: string; slug: string } | null>(null);
	let loadError = $state<string | null>(null);
	let redeploying = $state(false);
	let deleting = $state(false);
	let renaming = $state(false);
	let renameOpen = $state(false);
	let deleteOpen = $state(false);
	let autoDeploy = $state(false);
	let savingAutoDeploy = $state(false);

	const orgSlug = $derived($page.params.orgSlug);
	const stackId = $derived($page.params.stackId);

	const branch = $derived(stack?.autoDeployBranch ?? stack?.githubBranch ?? 'main');
	const composePath = $derived(stack?.composePath ?? 'docker-compose.yml');
	const repoPath = $derived(repoLabel(stack?.githubRepo));
	const projectHref = $derived(project ? `/${orgSlug}/projects/${project.slug}?tab=compose` : null);

	const facts = $derived.by(() => {
		if (!stack?.githubRepo) return [];
		const repo = stack.githubRepo.replace(/\.git$/, '');
		return [
			{ label: repoPath, icon: Github, href: repo, external: true },
			{ label: stack.githubBranch ?? 'main', icon: GitBranch, mono: true },
			...(stack.lastCommitSha
				? [
						{
							label: stack.lastCommitSha.slice(0, 7),
							icon: GitCommitHorizontal,
							href: `${repo}/commit/${stack.lastCommitSha}`,
							external: true,
							mono: true
						}
					]
				: [])
		];
	});

	const fileHref = $derived(
		stack?.githubRepo
			? `${stack.githubRepo.replace(/\.git$/, '')}/blob/${stack.githubBranch ?? 'main'}/${composePath}`
			: null
	);

	function repoLabel(url: string | null | undefined) {
		if (!url) return '';
		try {
			return new URL(url).pathname.replace(/^\/+|\.git$/g, '');
		} catch {
			return url;
		}
	}

	async function failure(response: Response, fallback: string) {
		const data = await response.json().catch(() => ({}));
		return new Error(data.message || fallback);
	}

	function toastError(title: string, e: unknown) {
		toasts.add({ title, description: e instanceof Error ? e.message : undefined, color: 'error' });
	}

	function take(next: ComposeStack) {
		stack = next;
		autoDeploy = next.autoDeployEnabled;
	}

	async function fetchStack() {
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}`);
			if (!response.ok) throw await failure(response, 'Compose stack not found');
			take(await response.json());
			loadError = null;
			if (!project) fetchProject(stack!.projectId);
		} catch (e) {
			if (!stack) loadError = e instanceof Error ? e.message : 'Compose stack not found';
		}
	}

	async function fetchProject(id: string) {
		const response = await apiFetch(`/apiv1/projects/${id}`).catch(() => null);
		if (response?.ok) project = await response.json();
	}

	async function redeploy() {
		redeploying = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}/redeploy`, {
				method: 'POST'
			});
			if (!response.ok) throw await failure(response, 'Redeploy failed');
			take(await response.json());
			toasts.add({ title: 'Redeploying', color: 'success' });
		} catch (e) {
			toastError('Redeploy failed', e);
		} finally {
			redeploying = false;
		}
	}

	async function saveAutoDeploy(enabled: boolean) {
		savingAutoDeploy = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}/auto-deploy`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			if (!response.ok) throw await failure(response, "Couldn't change auto-deploy");
			take(await response.json());
		} catch (e) {
			autoDeploy = !enabled;
			toastError('Auto-deploy unchanged', e);
		} finally {
			savingAutoDeploy = false;
		}
	}

	async function rename(name: string) {
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}/name`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) throw await failure(response, 'Rename failed');
			take(await response.json());
			renameOpen = false;
			toasts.add({ title: 'Stack renamed', color: 'success' });
		} catch (e) {
			toastError('Rename failed', e);
		} finally {
			renaming = false;
		}
	}

	async function remove() {
		if (!stack) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}`, { method: 'DELETE' });
			if (!response.ok) throw await failure(response, 'Delete failed');
			toasts.add({ title: 'Stack deleted', color: 'success' });
			if (projectHref) goto(projectHref);
			else history.back();
		} catch (e) {
			toastError('Delete failed', e);
		} finally {
			deleting = false;
		}
	}

	$effect(() => {
		if (stackId) fetchStack();
	});

	let sseUnsub: (() => void) | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let subscribedOrgId: string | null = null;
	$effect(() => {
		const id = $selectedOrganization?.id ?? null;
		if (!id || id === subscribedOrgId) return;
		subscribedOrgId = id;
		sseUnsub?.();
		sseUnsub = subscribeOrgEvents(id, (ev) => {
			if (
				ev.type !== 'deployment.changed' &&
				ev.type !== 'build.changed' &&
				ev.type !== 'project.changed'
			)
				return;
			const projectId = stack?.projectId;
			if (!projectId) return;
			const relevant =
				ev.projectId === projectId || (ev.type === 'project.changed' && ev.id === projectId);
			if (!relevant || refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				fetchStack();
			}, 2000);
		});
	});

	onDestroy(() => {
		sseUnsub?.();
		if (refreshTimer) clearTimeout(refreshTimer);
	});
</script>

{#if stack}
	{@const status = resourceStatus(stack.status, stack.buildStatus)}
	<Page title={stack.name}>
		{#snippet eyebrow()}
			<Breadcrumbs
				crumbs={[
					{ label: 'Home', href: `/${orgSlug}` },
					...(project && projectHref ? [{ label: project.name, href: projectHref }] : []),
					{ label: 'Compose stack' }
				]}
			/>
		{/snippet}
		{#snippet meta()}
			<StatusBadge meta={status} />
			{#if facts.length}<MetaList items={facts} />{/if}
		{/snippet}
		{#snippet actions()}
			{#if stack?.githubRepo}
				<Button variant="secondary" icon={RefreshCw} loading={redeploying} onclick={redeploy}
					>Redeploy</Button
				>
			{/if}
			<Menu placement="bottom-end">
				{#snippet trigger(props)}
					<Button {...props} variant="ghost" icon={Ellipsis} label="More actions" />
				{/snippet}
				<MenuItem icon={Pencil} onclick={() => (renameOpen = true)}>Rename</MenuItem>
				<MenuSeparator />
				<MenuItem icon={Trash2} danger disabled={deleting} onclick={() => (deleteOpen = true)}
					>Delete stack</MenuItem
				>
			</Menu>
		{/snippet}

		<Stack gap="xl">
			{#if stack.status === 'failed' && stack.lastError}
				<Alert tone="error" title="Last deploy failed">{stack.lastError}</Alert>
			{/if}

			<section class="block">
				<SectionTitle size="md" title="Services" count={stack.deployments.length} />
				{#if stack.deployments.length}
					<List label="Services">
						{#each stack.deployments as dep (dep.id)}
							<EntityRow
								kind="deployment"
								name={dep.composeServiceName ?? dep.name}
								status={resourceStatus(dep.status, dep.buildStatus)}
								detail={dep.image}
								href="/{orgSlug}/deployments/{dep.id}"
							/>
						{/each}
					</List>
				{:else}
					<EmptyState
						title="No services"
						description="The compose file didn't define any services."
					/>
				{/if}
			</section>

			{#if stack.githubRepo}
				<SectionCard>
					<ToggleRow
						label="Deploy on push to {branch}"
						hint="Rebuilds the services that build from the repo"
						bind:checked={autoDeploy}
						disabled={savingAutoDeploy}
						onchange={() => saveAutoDeploy(autoDeploy)}
					/>
				</SectionCard>
			{/if}

			<section class="block">
				<SectionTitle size="md" title="Compose file">
					{#snippet actions()}
						{#if fileHref}
							<Button
								href={fileHref}
								target="_blank"
								rel="noopener noreferrer"
								variant="secondary"
								size="sm"
								iconRight={ExternalLink}>Edit on GitHub</Button
							>
						{/if}
					{/snippet}
				</SectionTitle>
				<CodeBlock code={stack.composeYaml} title={composePath} lineNumbers />
			</section>
		</Stack>
	</Page>

	<ConfirmModal
		bind:open={deleteOpen}
		title="Delete {stack.name}?"
		description="Its {stack.deployments.length === 1
			? 'service is'
			: `${stack.deployments.length} services are`} deleted with it."
		confirmLabel="Delete stack"
		confirmText={stack.name}
		onconfirm={remove}
		oncancel={() => {}}
	/>
	<RenameModal
		bind:open={renameOpen}
		title="Rename stack"
		value={stack.name}
		saving={renaming}
		onSave={rename}
	/>
{:else if loadError}
	<Page title="Compose stack">
		<EmptyState title="This stack didn't load" description={loadError}>
			<Button variant="secondary" onclick={fetchStack}>Try again</Button>
		</EmptyState>
	</Page>
{:else}
	<Page title="Compose stack">
		<Stack gap="xl">
			<Skeleton height="4.5rem" rounded="calc(var(--radius-card) * var(--corner-scale))" />
			<Skeleton height="16rem" rounded="calc(var(--radius-card) * var(--corner-scale))" />
		</Stack>
	</Page>
{/if}

<style>
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
</style>
