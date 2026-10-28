<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { apiFetch, toasts, fetchProjectContext } from '$lib/stores';
	import { Globe, Eye, EyeOff } from 'lucide-svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import {
		Alert,
		Badge,
		Breadcrumbs,
		Button,
		Disclosure,
		Field,
		Input,
		Page,
		SectionCard,
		SegmentedControl,
		Dropdown,
		Skeleton,
		ToggleRow,
		ToneTile
	} from '$lib/components/ui';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import ProductHeader from '$lib/components/patterns/ProductHeader.svelte';
	import { templateCategory } from '$lib/utils/template-categories';

	interface ParameterDef {
		name: string;
		displayName: string;
		description?: string;
		type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
		default?: any;
		required?: boolean;
		placeholder?: string;
		validation?: {
			pattern?: string;
			message?: string;
			min?: number;
			max?: number;
			bytes?: number;
		};
		options?: { label: string; value: string }[];
	}

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
		parameters: ParameterDef[];
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

	function isDomainParam(param: ParameterDef): boolean {
		if (param.type !== 'string') return false;
		const tokens = param.name.split(/(?=[A-Z])|[_\s-]/).map((t) => t.toLowerCase());
		return tokens.some((t) => t === 'domain' || t === 'host' || t === 'hostname');
	}

	function isNameParam(param: ParameterDef): boolean {
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

	function normalizeNameParam(param: ParameterDef) {
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

	const KIND_LABEL = { deployment: 'App', database: 'Database', ingress: 'Public URL' } as const;

	let revealed = $state<Record<string, boolean>>({});
	let touched = $state<Record<string, boolean>>({});

	const ORDER = { string: 0, select: 1, number: 2, boolean: 3, secret: 4 } as const;
	const settings = $derived(
		(template?.parameters ?? [])
			.filter((p) => p.type !== 'secret')
			.toSorted((a, b) => ORDER[a.type] - ORDER[b.type])
	);
	const secrets = $derived((template?.parameters ?? []).filter((p) => p.type === 'secret'));

	function problem(param: ParameterDef): string | null {
		const v = paramValues[param.name];
		const empty = v === undefined || v === null || v === '';
		if (empty) return param.required ? `${param.displayName} is required` : null;
		if (param.type === 'number') {
			const n = Number(v);
			if (Number.isNaN(n)) return 'Enter a number';
			if (param.validation?.min !== undefined && n < param.validation.min)
				return `At least ${param.validation.min}`;
			if (param.validation?.max !== undefined && n > param.validation.max)
				return `At most ${param.validation.max}`;
		}
		if (param.type === 'string' && param.validation?.pattern) {
			if (!new RegExp(param.validation.pattern).test(String(v)))
				return param.validation.message ?? 'This value is not valid';
		}
		return null;
	}

	const problems = $derived(
		Object.fromEntries((template?.parameters ?? []).map((p) => [p.name, problem(p)]))
	);
	const blocked = $derived(Object.values(problems).some(Boolean));

	function unitOf(param: ParameterDef) {
		if (/gi$/i.test(param.name)) return 'GiB';
		if (/interval|seconds/i.test(param.name)) return 'sec';
		return undefined;
	}

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
		<div class="loading">
			<Skeleton height="8rem" width="8rem" rounded="1.75rem" />
			<Skeleton height="16rem" rounded="1.125rem" />
		</div>
	</Page>
{:else if template}
	{@const tpl = template}
	<Page title={tpl.displayName} width="default">
		{#snippet header()}{@render crumbs()}{/snippet}
		{#snippet aside()}
			<div class="side">
				<SectionCard title="Deploy into">
					<div class="deploy">
						<ProjectSwitcher
							currentProjectName={project?.name || projectSlug}
							pathSuffix={`/templates/deploy/${templateId}`}
						/>
						<Button
							variant="primary"
							size="lg"
							type="submit"
							form="deploy-template"
							loading={deploying}
							class="deploy-btn"
						>
							Deploy {tpl.displayName}
						</Button>
						<p class="deploy-note">Takes about a minute. Everything stays editable afterwards.</p>
					</div>
				</SectionCard>
				<SectionCard title="What gets created">
					<ul class="creates">
						{#each tpl.resources as resource (resource.name)}
							<li class="create">
								{#if resource.type === 'ingress'}
									<ToneTile tone="info" size={28}><Globe size={14} /></ToneTile>
								{:else}
									<AppIcon name={resource.name} kind={resource.type} size="sm" />
								{/if}
								<span class="create-name">{resource.name}</span>
								<span class="create-kind">{KIND_LABEL[resource.type]}</span>
							</li>
						{/each}
					</ul>
				</SectionCard>
			</div>
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
				<SectionCard
					title="Configure"
					description="Applied when it deploys. You can change each app later."
				>
					<div class="fields">
						{#each settings as param (param.name)}
							{@const issue = touched[param.name] ? problems[param.name] : null}
							{#if param.type === 'boolean'}
								<ToggleRow
									label={param.displayName}
									hint={param.description ?? null}
									bind:checked={paramValues[param.name]}
									disabled={deploying}
								/>
							{:else if param.type === 'select'}
								<Field
									label={param.displayName}
									hint={param.description}
									for="p-{param.name}"
									required={param.required}
								>
									{#if (param.options ?? []).length <= 4}
										<SegmentedControl
											label={param.displayName}
											size="sm"
											options={(param.options ?? []).map((o) => ({
												value: o.value,
												label: o.label
											}))}
											bind:value={paramValues[param.name]}
										/>
									{:else}
										<Dropdown
											id="p-{param.name}"
											bind:value={paramValues[param.name]}
											disabled={deploying}
											options={(param.options ?? []).map((o) => ({
												value: o.value,
												label: o.label
											}))}
										/>
									{/if}
								</Field>
							{:else if param.type === 'number'}
								<Field
									label={param.displayName}
									hint={param.description}
									error={issue}
									for="p-{param.name}"
									required={param.required}
								>
									<span class="short">
										<Input
											id="p-{param.name}"
											type="number"
											min={param.validation?.min}
											max={param.validation?.max}
											suffix={unitOf(param)}
											error={!!issue}
											bind:value={paramValues[param.name]}
											disabled={deploying}
											onblur={() => (touched[param.name] = true)}
										/></span
									>
								</Field>
							{:else}
								<Field
									label={param.displayName}
									error={issue}
									for="p-{param.name}"
									required={param.required}
								>
									<Input
										id="p-{param.name}"
										placeholder={param.placeholder || ''}
										error={!!issue}
										bind:value={paramValues[param.name]}
										disabled={deploying}
										onblur={() => {
											normalizeNameParam(param);
											touched[param.name] = true;
										}}
									/>
									{#snippet hint()}
										{param.description ?? ''}
										{#if isDomainParam(param) && suggestedDomain && paramValues[param.name] !== suggestedDomain}
											<span class="suggest">
												<Button
													size="sm"
													variant="tinted"
													onclick={() => (paramValues[param.name] = suggestedDomain)}
												>
													Use {suggestedDomain}
												</Button>
											</span>
										{/if}
									{/snippet}
								</Field>
							{/if}
						{/each}
					</div>
				</SectionCard>
			{/if}

			{#if secrets.length}
				<SectionCard
					title="Secrets"
					description="Leave them empty and Orchard generates strong values on deploy."
				>
					<div class="fields">
						{#each secrets as param (param.name)}
							<Field label={param.displayName} for="p-{param.name}">
								<Input
									id="p-{param.name}"
									type={revealed[param.name] ? 'text' : 'password'}
									placeholder="Generated on deploy"
									autocomplete="off"
									class="secret"
									bind:value={paramValues[param.name]}
									disabled={deploying}
								>
									{#snippet suffix()}
										<Button
											size="sm"
											variant="ghost"
											icon={revealed[param.name] ? EyeOff : Eye}
											label={revealed[param.name] ? 'Hide' : 'Show'}
											onclick={() => (revealed[param.name] = !revealed[param.name])}
										/>
									{/snippet}
								</Input>
							</Field>
						{/each}
					</div>
				</SectionCard>
			{/if}

			<SectionCard
				title="Resources"
				description="CPU and memory for every app and database it creates."
			>
				<Disclosure title="Set limits" note="Org defaults if you skip this">
					<ResourcePicker
						bind:cpuMilli={resourceCpuMilli}
						bind:memoryBytes={resourceMemoryBytes}
						disabled={deploying}
					/>
				</Disclosure>
			</SectionCard>
		</form>
	</Page>
{:else}
	<Page title="Template not found" width="narrow">
		<Alert tone="error">{error ?? 'This template does not exist or was removed.'}</Alert>
	</Page>
{/if}

<style>
	.side {
		position: sticky;
		top: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.deploy {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.deploy :global(.deploy-btn) {
		width: 100%;
	}
	.deploy-note {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.loading {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
	}
	.short {
		display: block;
		max-width: 12rem;
	}
	.suggest {
		display: block;
		margin-top: 0.5rem;
	}
	.creates {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.create {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
	}
	.create-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.create-kind {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
