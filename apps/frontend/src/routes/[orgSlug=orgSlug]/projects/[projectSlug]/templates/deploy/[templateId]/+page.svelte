<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { apiFetch, toasts, fetchProjectContext } from '$lib/stores';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import {
		Alert,
		Badge,
		Breadcrumbs,
		FormActions,
		Button,
		Page,
		SectionCard,
		Skeleton,
		Stack
	} from '$lib/components/ui';
	import ParamField, {
		paramProblem,
		type ParamDef
	} from '$lib/components/patterns/ParamField.svelte';
	import ResourceList from '$lib/components/patterns/ResourceList.svelte';
	import ProductHeader from '$lib/components/patterns/ProductHeader.svelte';
	import { templateCategory } from '$lib/utils/template-categories';

	interface ResourceSummary {
		name: string;
		type: 'deployment' | 'database' | 'ingress';
	}

	interface TemplateDetail {
		id: string;
		name: string;
		displayName: string;
		description?: string;
		icon?: string;
		version: string;
		category?: string;
		tags: string[];
		parameters: ParamDef[];
		resources: ResourceSummary[];
	}

	let template = $state<TemplateDetail | null>(null);
	let project = $state<{ id: string; name: string } | null>(null);
	let loading = $state(true);
	let deploying = $state(false);
	let error = $state<string | null>(null);
	let paramValues = $state<Record<string, any>>({});
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);

	const orgSlug = $derived($page.params.orgSlug ?? '');
	const projectSlug = $derived($page.params.projectSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const templateId = $derived($page.params.templateId ?? '');

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN ?? '';

	function isDomainParam(param: ParamDef): boolean {
		if (param.type !== 'string') return false;
		const tokens = param.name.split(/(?=[A-Z])|[_\s-]/).map((t) => t.toLowerCase());
		return tokens.some((t) => t === 'domain' || t === 'host' || t === 'hostname');
	}

	function isNameParam(param: ParamDef): boolean {
		if (param.type !== 'string') return false;
		if (isDomainParam(param)) return false;
		const tokens = param.name.split(/(?=[A-Z])|[_\s-]/).map((t) => t.toLowerCase());
		return tokens.some((t) => t === 'name');
	}

	function slugify(value: string): string {
		return value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+/, '')
			.substring(0, 60)
			.replace(/-+$/, '');
	}

	function normalizeNameParam(param: ParamDef) {
		if (!isNameParam(param)) return;
		const raw = paramValues[param.name];
		if (typeof raw !== 'string' || !raw.trim()) return;
		const pattern = param.validation?.pattern;
		if (!pattern) return;
		const regex = new RegExp(pattern);
		if (regex.test(raw)) return;
		const slug = slugify(raw);
		if (slug && regex.test(slug)) paramValues[param.name] = slug;
	}

	const appNameValue = $derived.by(() => {
		const nameParam = template?.parameters.find((p) => /name/i.test(p.name) && p.type === 'string');
		const v = nameParam ? paramValues[nameParam.name] : '';
		return typeof v === 'string' ? v.trim() : '';
	});

	const suggestedDomain = $derived(
		appNameValue && APP_DOMAIN
			? `${appNameValue
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, '-')
					.replace(/^-+|-+$/g, '')}.${APP_DOMAIN}`
			: null
	);

	let touched = $state<Record<string, boolean>>({});

	const ORDER = { string: 0, select: 1, number: 2, boolean: 3, secret: 4 } as const;
	const settings = $derived(
		(template?.parameters ?? [])
			.filter((p) => p.type !== 'secret')
			.toSorted((a, b) => ORDER[a.type] - ORDER[b.type])
	);
	const secrets = $derived((template?.parameters ?? []).filter((p) => p.type === 'secret'));

	const problems = $derived(
		Object.fromEntries(
			(template?.parameters ?? []).map((p) => [p.name, paramProblem(p, paramValues[p.name])])
		)
	);
	const blocked = $derived(Object.values(problems).some(Boolean));

	async function fetchTemplate() {
		try {
			const tplRes = await apiFetch(`/apiv1/templates/${templateId}`);
			if (!tplRes.ok) throw new Error('Failed to fetch template');
			template = await tplRes.json();

			for (const param of template!.parameters) {
				if (param.default !== undefined) {
					paramValues[param.name] = param.default;
				} else if (param.type === 'boolean') {
					paramValues[param.name] = false;
				} else {
					paramValues[param.name] = '';
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load template';
		}
	}

	async function fetchProject() {
		try {
			project = await fetchProjectContext({ orgSlug, projectSlug, wsSlug });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load project';
		}
	}

	async function fetchData() {
		loading = true;
		await Promise.all([fetchTemplate(), fetchProject()]);
		loading = false;
	}

	async function deploy() {
		if (!project || !template) return;
		touched = Object.fromEntries(template.parameters.map((p) => [p.name, true]));
		if (blocked) return;

		deploying = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/template-instances`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					templateId: template.id,
					parameters: paramValues,
					cpuRequestMilli: resourceCpuMilli,
					memoryRequestBytes: resourceMemoryBytes
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to deploy template');
			}

			const instance = await response.json();

			toasts.add({
				title: 'Template deployed',
				description: `${template.displayName} is deployed`,
				color: 'success'
			});

			goto(`/${orgSlug}/template-instances/${instance.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to deploy template';
		} finally {
			deploying = false;
		}
	}

	onMount(fetchData);

	let didInit = $state(false);
	$effect(() => {
		orgSlug;
		projectSlug;
		wsSlug;
		if (!didInit) {
			didInit = true;
			return;
		}
		if (orgSlug && projectSlug) {
			fetchProject();
		}
	});
</script>

<svelte:head><title>Deploy {template?.displayName ?? 'template'}</title></svelte:head>

{#snippet crumbs()}
	<Breadcrumbs
		crumbs={[
			{ label: 'Home', href: `/${orgSlug}` },
			{ label: 'New', href: `/${orgSlug}/new?projectSlug=${projectSlug}` },
			{ label: template?.displayName ?? 'Template' }
		]}
	/>
{/snippet}

{#if loading}
	<Page title="Deploy template" width="default">
		<Stack gap="lg">
			<Skeleton height="8rem" width="8rem" rounded="1.75rem" />
			<Skeleton height="16rem" rounded="1.125rem" />
		</Stack>
	</Page>
{:else if template}
	{@const tpl = template}
	<Page title={tpl.displayName} width="default">
		{#snippet header()}{@render crumbs()}{/snippet}
		{#snippet aside()}
			<Stack sticky>
				<SectionCard title="Deploy into">
					<ProjectSwitcher
						currentProjectName={project?.name || projectSlug}
						pathSuffix={`/templates/deploy/${templateId}`}
					/>
				</SectionCard>
				<SectionCard title="What gets created">
					<ResourceList items={tpl.resources} />
				</SectionCard>
			</Stack>
		{/snippet}

		<form
			id="deploy-template"
			class="form"
			novalidate
			onsubmit={(e) => {
				e.preventDefault();
				deploy();
			}}
		>
			<ProductHeader
				title={tpl.displayName}
				eyebrow={templateCategory(tpl.category)}
				description={tpl.description}
				icon={tpl.icon}
			>
				{#snippet meta()}
					<Badge>v{tpl.version}</Badge>
					{#each tpl.tags.slice(0, 3) as tag (tag)}<Badge>{tag}</Badge>{/each}
				{/snippet}
			</ProductHeader>
			{#if error}<Alert tone="error">{error}</Alert>{/if}

			{#if settings.length}
				<SectionCard title="Configure">
					<Stack gap="lg">
						{#each settings as param (param.name)}
							<ParamField
								{param}
								bind:value={paramValues[param.name]}
								error={touched[param.name] ? problems[param.name] : null}
								disabled={deploying}
								suggestion={isDomainParam(param) ? suggestedDomain : null}
								onblur={() => {
									normalizeNameParam(param);
									touched[param.name] = true;
								}}
							/>
						{/each}
					</Stack>
				</SectionCard>
			{/if}

			{#if secrets.length}
				<SectionCard
					title="Secrets"
					description="Leave them empty and Orchard generates strong values on deploy."
				>
					<Stack gap="lg">
						{#each secrets as param (param.name)}
							<ParamField {param} bind:value={paramValues[param.name]} disabled={deploying} />
						{/each}
					</Stack>
				</SectionCard>
			{/if}

			<SectionCard
				title="Resources"
				description="CPU and memory for every app and database it creates."
			>
				<ResourcePicker
					bind:cpuMilli={resourceCpuMilli}
					bind:memoryBytes={resourceMemoryBytes}
					disabled={deploying}
				/>
			</SectionCard>

			<FormActions>
				<Button variant="ghost" href={`/${orgSlug}/new?projectSlug=${projectSlug}`}>Cancel</Button>
				<Button variant="primary" size="lg" type="submit" loading={deploying}>
					Deploy {tpl.displayName}
				</Button>
			</FormActions>
		</form>
	</Page>
{:else}
	<Page title="Template not found" width="narrow">
		<Alert tone="error">{error ?? 'This template does not exist or was removed.'}</Alert>
	</Page>
{/if}

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
</style>
