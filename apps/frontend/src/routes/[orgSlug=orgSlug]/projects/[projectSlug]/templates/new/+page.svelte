<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { apiFetch, toasts, buildBasePath } from '$lib/stores';
	import {
		Loader2,
		LayoutTemplate,
		Plus,
		Trash2,
		Code,
		SlidersHorizontal,
		ChevronDown,
		ChevronUp
	} from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';

	type ParamType = 'string' | 'number' | 'boolean' | 'select';
	type ResourceType = 'deployment' | 'database' | 'ingress';

	interface Param {
		name: string;
		displayName: string;
		description: string;
		type: ParamType;
		default: string;
		required: boolean;
		placeholder: string;
		validationPattern: string;
		validationMessage: string;
		validationMin: string;
		validationMax: string;
		options: { label: string; value: string }[];
	}

	interface EnvVar {
		key: string;
		value: string;
	}

	interface Port {
		name: string;
		containerPort: number;
		servicePort: number;
		protocol: string;
	}

	interface Route {
		path: string;
		serviceName: string;
		servicePort: number;
	}

	interface Resource {
		name: string;
		type: ResourceType;
		expanded: boolean;
		// database
		dbName: string;
		// deployment
		image: string;
		replicas: string;
		ports: Port[];
		env: EnvVar[];
		// ingress
		host: string;
		tlsEnabled: boolean;
		routes: Route[];
	}

	const orgSlug = $derived($page.params.orgSlug ?? '');
	const projectSlug = $derived($page.params.projectSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const basePath = $derived(buildBasePath({ orgSlug, projectSlug, wsSlug }));

	let mode = $state<'visual' | 'yaml'>('visual');
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Visual editor state
	let metaName = $state('my-template');
	let metaDisplayName = $state('My Template');
	let metaDescription = $state('');
	let metaIcon = $state('');
	let metaVersion = $state('1.0.0');
	let metaCategory = $state('');
	let metaTags = $state('');

	let parameters = $state<Param[]>([]);
	let resources = $state<Resource[]>([]);

	// YAML editor state
	let yamlContent = $state(exampleYaml());

	function exampleYaml(): string {
		return `apiVersion: leaf/v1
kind: Template
metadata:
  name: my-template
  displayName: My Template
  description: A custom template
  icon: server
  version: "1.0.0"
  category: backend
  tags: ["custom"]

parameters:
  - name: app-name
    displayName: App Name
    description: Name for the application
    type: string
    default: my-app
    required: true
    validation:
      pattern: "^[a-z][a-z0-9-]{1,58}[a-z0-9]$"
      message: Must be lowercase alphanumeric with hyphens, 3-60 chars

  - name: image
    displayName: Docker Image
    description: Docker image to deploy
    type: string
    required: true
    placeholder: "registry/image:tag"

  - name: port
    displayName: App Port
    type: number
    default: 3000
    validation:
      min: 1
      max: 65535

  - name: replicas
    displayName: Replicas
    type: number
    default: 1
    validation:
      min: 1
      max: 10

  - name: domain
    displayName: Domain
    description: Public domain for the application
    type: string
    required: true
    placeholder: "app.example.com"

  - name: enable-tls
    displayName: Enable HTTPS
    type: boolean
    default: true

resources:
  - name: app
    type: deployment
    config:
      name: "{{ params.app-name }}"
      image: "{{ params.image }}"
      replicas: "{{ params.replicas }}"
      ports:
        - name: http
          containerPort: "{{ params.port }}"
          servicePort: "{{ params.port }}"
          protocol: TCP
      env:
        - key: PORT
          value: "{{ params.port }}"
        - key: NODE_ENV
          value: production

  - name: ingress
    type: ingress
    config:
      host: "{{ params.domain }}"
      tlsEnabled: "{{ params.enable-tls }}"
      routes:
        - path: /
          serviceName: "{{ resources.app.serviceName }}"
          servicePort: "{{ params.port }}"
`;
	}

	function addParameter() {
		parameters = [
			...parameters,
			{
				name: '',
				displayName: '',
				description: '',
				type: 'string',
				default: '',
				required: false,
				placeholder: '',
				validationPattern: '',
				validationMessage: '',
				validationMin: '',
				validationMax: '',
				options: []
			}
		];
	}

	function removeParameter(index: number) {
		parameters = parameters.filter((_, i) => i !== index);
	}

	function addOption(paramIndex: number) {
		parameters[paramIndex].options = [...parameters[paramIndex].options, { label: '', value: '' }];
	}

	function removeOption(paramIndex: number, optIndex: number) {
		parameters[paramIndex].options = parameters[paramIndex].options.filter(
			(_, i) => i !== optIndex
		);
	}

	function addResource() {
		resources = [
			...resources,
			{
				name: '',
				type: 'deployment',
				expanded: true,
				dbName: '',
				image: '',
				replicas: '1',
				ports: [{ name: 'http', containerPort: 3000, servicePort: 3000, protocol: 'TCP' }],
				env: [],
				host: '',
				tlsEnabled: true,
				routes: [{ path: '/', serviceName: '', servicePort: 80 }]
			}
		];
	}

	function removeResource(index: number) {
		resources = resources.filter((_, i) => i !== index);
	}

	function addEnvVar(resIndex: number) {
		resources[resIndex].env = [...resources[resIndex].env, { key: '', value: '' }];
	}

	function removeEnvVar(resIndex: number, envIndex: number) {
		resources[resIndex].env = resources[resIndex].env.filter((_, i) => i !== envIndex);
	}

	function addPort(resIndex: number) {
		resources[resIndex].ports = [
			...resources[resIndex].ports,
			{ name: '', containerPort: 8080, servicePort: 8080, protocol: 'TCP' }
		];
	}

	function removePort(resIndex: number, portIndex: number) {
		resources[resIndex].ports = resources[resIndex].ports.filter((_, i) => i !== portIndex);
	}

	function addRoute(resIndex: number) {
		resources[resIndex].routes = [
			...resources[resIndex].routes,
			{ path: '/', serviceName: '', servicePort: 80 }
		];
	}

	function removeRoute(resIndex: number, routeIndex: number) {
		resources[resIndex].routes = resources[resIndex].routes.filter((_, i) => i !== routeIndex);
	}

	function visualToYaml(): string {
		const lines: string[] = [];
		lines.push('apiVersion: leaf/v1');
		lines.push('kind: Template');
		lines.push('metadata:');
		lines.push(`  name: ${metaName}`);
		lines.push(`  displayName: ${metaDisplayName}`);
		if (metaDescription) lines.push(`  description: ${metaDescription}`);
		if (metaIcon) lines.push(`  icon: ${metaIcon}`);
		lines.push(`  version: "${metaVersion}"`);
		if (metaCategory) lines.push(`  category: ${metaCategory}`);
		if (metaTags.trim()) {
			const tags = metaTags
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			lines.push(`  tags: [${tags.map((t) => `"${t}"`).join(', ')}]`);
		}

		if (parameters.length > 0) {
			lines.push('');
			lines.push('parameters:');
			for (const p of parameters) {
				lines.push(`  - name: ${p.name}`);
				lines.push(`    displayName: ${p.displayName || p.name}`);
				if (p.description) lines.push(`    description: ${p.description}`);
				lines.push(`    type: ${p.type}`);
				if (p.default) lines.push(`    default: ${p.type === 'string' ? p.default : p.default}`);
				if (p.required) lines.push(`    required: true`);
				if (p.placeholder) lines.push(`    placeholder: "${p.placeholder}"`);
				if (
					(p.type === 'string' && p.validationPattern) ||
					(p.type === 'number' && (p.validationMin || p.validationMax))
				) {
					lines.push('    validation:');
					if (p.type === 'string' && p.validationPattern) {
						lines.push(`      pattern: "${p.validationPattern}"`);
						if (p.validationMessage) lines.push(`      message: ${p.validationMessage}`);
					}
					if (p.type === 'number') {
						if (p.validationMin) lines.push(`      min: ${p.validationMin}`);
						if (p.validationMax) lines.push(`      max: ${p.validationMax}`);
					}
				}
				if (p.type === 'select' && p.options.length > 0) {
					lines.push('    options:');
					for (const o of p.options) {
						lines.push(`      - label: "${o.label}"`);
						lines.push(`        value: "${o.value}"`);
					}
				}
			}
		}

		if (resources.length > 0) {
			lines.push('');
			lines.push('resources:');
			for (const r of resources) {
				lines.push(`  - name: ${r.name}`);
				lines.push(`    type: ${r.type}`);
				lines.push('    config:');
				switch (r.type) {
					case 'database':
						lines.push(`      name: "${r.dbName}"`);
						break;
					case 'deployment':
						lines.push(`      name: "${r.name}"`);
						lines.push(`      image: "${r.image}"`);
						lines.push(`      replicas: ${r.replicas}`);
						if (r.ports.length > 0) {
							lines.push('      ports:');
							for (const port of r.ports) {
								lines.push(`        - name: ${port.name}`);
								lines.push(`          containerPort: ${port.containerPort}`);
								lines.push(`          servicePort: ${port.servicePort}`);
								lines.push(`          protocol: ${port.protocol}`);
							}
						}
						if (r.env.length > 0) {
							lines.push('      env:');
							for (const e of r.env) {
								lines.push(`        - key: ${e.key}`);
								lines.push(`          value: "${e.value}"`);
							}
						}
						break;
					case 'ingress':
						lines.push(`      host: "${r.host}"`);
						lines.push(`      tlsEnabled: ${r.tlsEnabled}`);
						if (r.routes.length > 0) {
							lines.push('      routes:');
							for (const route of r.routes) {
								lines.push(`        - path: ${route.path}`);
								lines.push(`          serviceName: "${route.serviceName}"`);
								lines.push(`          servicePort: ${route.servicePort}`);
							}
						}
						break;
				}
			}
		}

		lines.push('');
		return lines.join('\n');
	}

	function switchToYaml() {
		if (mode === 'visual' && (parameters.length > 0 || resources.length > 0)) {
			yamlContent = visualToYaml();
		}
		mode = 'yaml';
	}

	function switchToVisual() {
		mode = 'visual';
	}

	async function save() {
		saving = true;
		error = null;

		try {
			const yaml = mode === 'yaml' ? yamlContent : visualToYaml();

			const response = await apiFetch('/apiv1/templates', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ yaml })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create template');
			}

			toasts.add({
				title: 'Template created',
				description: 'Your custom template is now available',
				color: 'success'
			});

			goto(`${basePath}/templates`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create template';
		} finally {
			saving = false;
		}
	}
</script>

<div class="nt-page">
	<Breadcrumb
		crumbs={[
			{ label: 'Home', href: `/${orgSlug}` },
			{ label: 'Templates', href: `${basePath}/templates` },
			{ label: 'New Template' }
		]}
	/>

	<div class="nt-header">
		<LayoutTemplate class="h-6 w-6" style="color: var(--sidebar-text-active-border)" />
		<div>
			<h1 class="nt-title">New Template</h1>
			<p class="nt-subtitle">Create a reusable application stack template</p>
		</div>
	</div>

	<!-- Mode toggle -->
	<div class="nt-mode-toggle">
		<button class="nt-mode-btn" class:nt-mode-active={mode === 'visual'} onclick={switchToVisual}>
			<SlidersHorizontal class="h-4 w-4" />
			Visual Editor
		</button>
		<button class="nt-mode-btn" class:nt-mode-active={mode === 'yaml'} onclick={switchToYaml}>
			<Code class="h-4 w-4" />
			YAML Editor
		</button>
	</div>

	{#if error}
		<div class="nt-error">{error}</div>
	{/if}

	{#if mode === 'yaml'}
		<!-- YAML Editor -->
		<div class="nt-yaml-section">
			<p class="nt-yaml-hint">
				Write your template YAML directly. See the
				<button
					class="nt-link"
					onclick={() => {
						yamlContent = exampleYaml();
					}}
				>
					example template
				</button>
				for reference.
			</p>
			<textarea class="nt-yaml-editor" bind:value={yamlContent} spellcheck="false" rows="30"
			></textarea>
		</div>
	{:else}
		<!-- Visual Editor -->
		<div class="nt-visual">
			<!-- Metadata -->
			<section class="nt-section">
				<h2 class="nt-section-title">Metadata</h2>
				<div class="nt-grid-2">
					<div class="nt-field">
						<label for="meta-name" class="nt-label">Name <span class="nt-req">*</span></label>
						<input
							id="meta-name"
							type="text"
							class="nt-input"
							bind:value={metaName}
							placeholder="my-template"
						/>
						<p class="nt-hint">Unique identifier (lowercase, hyphens)</p>
					</div>
					<div class="nt-field">
						<label for="meta-display" class="nt-label"
							>Display Name <span class="nt-req">*</span></label
						>
						<input
							id="meta-display"
							type="text"
							class="nt-input"
							bind:value={metaDisplayName}
							placeholder="My Template"
						/>
					</div>
				</div>
				<div class="nt-field">
					<label for="meta-desc" class="nt-label">Description</label>
					<input
						id="meta-desc"
						type="text"
						class="nt-input"
						bind:value={metaDescription}
						placeholder="What this template does"
					/>
				</div>
				<div class="nt-grid-3">
					<div class="nt-field">
						<label for="meta-icon" class="nt-label">Icon</label>
						<select id="meta-icon" class="nt-input nt-select" bind:value={metaIcon}>
							<option value="">None</option>
							<option value="server">Server</option>
							<option value="database">Database</option>
							<option value="globe">Globe</option>
							<option value="nodejs">Node.js</option>
							<option value="wordpress">WordPress</option>
							<option value="ghost">Ghost</option>
						</select>
					</div>
					<div class="nt-field">
						<label for="meta-cat" class="nt-label">Category</label>
						<select id="meta-cat" class="nt-input nt-select" bind:value={metaCategory}>
							<option value="">None</option>
							<option value="backend">Backend</option>
							<option value="frontend">Frontend</option>
							<option value="cms">CMS</option>
							<option value="database">Database</option>
						</select>
					</div>
					<div class="nt-field">
						<label for="meta-version" class="nt-label">Version</label>
						<input
							id="meta-version"
							type="text"
							class="nt-input"
							bind:value={metaVersion}
							placeholder="1.0.0"
						/>
					</div>
				</div>
				<div class="nt-field">
					<label for="meta-tags" class="nt-label">Tags</label>
					<input
						id="meta-tags"
						type="text"
						class="nt-input"
						bind:value={metaTags}
						placeholder="nodejs, api, postgres (comma-separated)"
					/>
				</div>
			</section>

			<!-- Parameters -->
			<section class="nt-section">
				<div class="nt-section-header">
					<h2 class="nt-section-title">Parameters</h2>
					<button class="nt-add-btn" onclick={addParameter}>
						<Plus class="h-3.5 w-3.5" />
						Add
					</button>
				</div>
				<p class="nt-section-desc">
					Parameters let users customize the template at deploy time. Use <code
						>{'{{ params.name }}'}</code
					> to reference them in resources.
				</p>

				{#each parameters as param, i}
					<div class="nt-param-card">
						<div class="nt-param-header">
							<span class="nt-param-num">#{i + 1}</span>
							<input
								type="text"
								class="nt-input nt-input-sm"
								bind:value={param.name}
								placeholder="param-name"
							/>
							<button class="nt-remove-btn" onclick={() => removeParameter(i)}>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</div>
						<div class="nt-grid-2">
							<div class="nt-field">
								<label class="nt-label-sm">Display Name</label>
								<input
									type="text"
									class="nt-input nt-input-sm"
									bind:value={param.displayName}
									placeholder="Display Name"
								/>
							</div>
							<div class="nt-field">
								<label class="nt-label-sm">Type</label>
								<select class="nt-input nt-input-sm nt-select" bind:value={param.type}>
									<option value="string">String</option>
									<option value="number">Number</option>
									<option value="boolean">Boolean</option>
									<option value="select">Select</option>
								</select>
							</div>
						</div>
						<div class="nt-field">
							<label class="nt-label-sm">Description</label>
							<input
								type="text"
								class="nt-input nt-input-sm"
								bind:value={param.description}
								placeholder="Help text for this parameter"
							/>
						</div>
						<div class="nt-grid-3">
							<div class="nt-field">
								<label class="nt-label-sm">Default</label>
								<input
									type="text"
									class="nt-input nt-input-sm"
									bind:value={param.default}
									placeholder="Default value"
								/>
							</div>
							<div class="nt-field">
								<label class="nt-label-sm">Placeholder</label>
								<input
									type="text"
									class="nt-input nt-input-sm"
									bind:value={param.placeholder}
									placeholder="Hint text"
								/>
							</div>
							<div class="nt-field nt-field-check">
								<label class="nt-check-label">
									<input type="checkbox" bind:checked={param.required} />
									Required
								</label>
							</div>
						</div>

						{#if param.type === 'string'}
							<div class="nt-grid-2">
								<div class="nt-field">
									<label class="nt-label-sm">Validation Pattern</label>
									<input
										type="text"
										class="nt-input nt-input-sm nt-input-mono"
										bind:value={param.validationPattern}
										placeholder="^[a-z][a-z0-9-]+$"
									/>
								</div>
								<div class="nt-field">
									<label class="nt-label-sm">Validation Message</label>
									<input
										type="text"
										class="nt-input nt-input-sm"
										bind:value={param.validationMessage}
										placeholder="Error message"
									/>
								</div>
							</div>
						{:else if param.type === 'number'}
							<div class="nt-grid-2">
								<div class="nt-field">
									<label class="nt-label-sm">Min</label>
									<input
										type="text"
										class="nt-input nt-input-sm"
										bind:value={param.validationMin}
										placeholder="0"
									/>
								</div>
								<div class="nt-field">
									<label class="nt-label-sm">Max</label>
									<input
										type="text"
										class="nt-input nt-input-sm"
										bind:value={param.validationMax}
										placeholder="100"
									/>
								</div>
							</div>
						{:else if param.type === 'select'}
							<div class="nt-options">
								<label class="nt-label-sm">Options</label>
								{#each param.options as opt, oi}
									<div class="nt-option-row">
										<input
											type="text"
											class="nt-input nt-input-sm"
											bind:value={opt.label}
											placeholder="Label"
										/>
										<input
											type="text"
											class="nt-input nt-input-sm"
											bind:value={opt.value}
											placeholder="Value"
										/>
										<button class="nt-remove-btn-sm" onclick={() => removeOption(i, oi)}>
											<Trash2 class="h-3 w-3" />
										</button>
									</div>
								{/each}
								<button class="nt-add-btn-sm" onclick={() => addOption(i)}>
									<Plus class="h-3 w-3" /> Add Option
								</button>
							</div>
						{/if}
					</div>
				{/each}

				{#if parameters.length === 0}
					<div class="nt-empty-inline">No parameters yet</div>
				{/if}
			</section>

			<!-- Resources -->
			<section class="nt-section">
				<div class="nt-section-header">
					<h2 class="nt-section-title">Resources</h2>
					<button class="nt-add-btn" onclick={addResource}>
						<Plus class="h-3.5 w-3.5" />
						Add
					</button>
				</div>
				<p class="nt-section-desc">
					Resources are created when deploying. Use <code>{'{{ resources.name.field }}'}</code> to reference
					other resources. Order matters &mdash; resources can only reference resources listed above them.
				</p>

				{#each resources as res, ri}
					<div class="nt-res-card">
						<div class="nt-res-header">
							<button
								class="nt-collapse-btn"
								onclick={() => {
									resources[ri].expanded = !resources[ri].expanded;
								}}
							>
								{#if res.expanded}
									<ChevronUp class="h-4 w-4" />
								{:else}
									<ChevronDown class="h-4 w-4" />
								{/if}
							</button>
							<input
								type="text"
								class="nt-input nt-input-sm"
								bind:value={res.name}
								placeholder="resource-name"
							/>
							<select
								class="nt-input nt-input-sm nt-select"
								style="max-width: 10rem"
								bind:value={res.type}
							>
								<option value="deployment">App</option>
								<option value="database">Database</option>
								<option value="ingress">Ingress</option>
							</select>
							<button class="nt-remove-btn" onclick={() => removeResource(ri)}>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</div>

						{#if res.expanded}
							<div class="nt-res-body">
								{#if res.type === 'database'}
									<div class="nt-field">
										<label class="nt-label-sm">Database Name</label>
										<input
											type="text"
											class="nt-input nt-input-sm"
											bind:value={res.dbName}
											placeholder={'{{ params.app-name }}-db'}
										/>
										<p class="nt-hint">Supports interpolation</p>
									</div>
									<div class="nt-res-context">
										<span class="nt-label-sm">Available in context:</span>
										<code>id</code> <code>host</code> <code>port</code> <code>dbName</code>
										<code>dbUser</code> <code>dbPassword</code> <code>connectionString</code>
									</div>
								{:else if res.type === 'deployment'}
									<div class="nt-grid-2">
										<div class="nt-field">
											<label class="nt-label-sm">Image</label>
											<input
												type="text"
												class="nt-input nt-input-sm"
												bind:value={res.image}
												placeholder={'{{ params.image }}'}
											/>
										</div>
										<div class="nt-field">
											<label class="nt-label-sm">Replicas</label>
											<input
												type="text"
												class="nt-input nt-input-sm"
												bind:value={res.replicas}
												placeholder="1"
											/>
										</div>
									</div>

									<!-- Ports -->
									<div class="nt-sub-section">
										<div class="nt-sub-header">
											<span class="nt-label-sm">Ports</span>
											<button class="nt-add-btn-sm" onclick={() => addPort(ri)}>
												<Plus class="h-3 w-3" /> Add
											</button>
										</div>
										{#each res.ports as port, pi}
											<div class="nt-port-row">
												<input
													type="text"
													class="nt-input nt-input-xs"
													bind:value={port.name}
													placeholder="name"
												/>
												<input
													type="number"
													class="nt-input nt-input-xs"
													bind:value={port.containerPort}
													placeholder="container"
												/>
												<input
													type="number"
													class="nt-input nt-input-xs"
													bind:value={port.servicePort}
													placeholder="service"
												/>
												<select class="nt-input nt-input-xs nt-select" bind:value={port.protocol}>
													<option value="TCP">TCP</option>
													<option value="UDP">UDP</option>
												</select>
												<button class="nt-remove-btn-sm" onclick={() => removePort(ri, pi)}>
													<Trash2 class="h-3 w-3" />
												</button>
											</div>
										{/each}
									</div>

									<!-- Env vars -->
									<div class="nt-sub-section">
										<div class="nt-sub-header">
											<span class="nt-label-sm">Environment Variables</span>
											<button class="nt-add-btn-sm" onclick={() => addEnvVar(ri)}>
												<Plus class="h-3 w-3" /> Add
											</button>
										</div>
										{#each res.env as env, ei}
											<div class="nt-env-row">
												<input
													type="text"
													class="nt-input nt-input-sm nt-input-mono"
													bind:value={env.key}
													placeholder="KEY"
												/>
												<input
													type="text"
													class="nt-input nt-input-sm"
													bind:value={env.value}
													placeholder={'value or {{ params.x }}'}
												/>
												<button class="nt-remove-btn-sm" onclick={() => removeEnvVar(ri, ei)}>
													<Trash2 class="h-3 w-3" />
												</button>
											</div>
										{/each}
									</div>

									<div class="nt-res-context">
										<span class="nt-label-sm">Available in context:</span>
										<code>id</code> <code>serviceName</code>
									</div>
								{:else if res.type === 'ingress'}
									<div class="nt-grid-2">
										<div class="nt-field">
											<label class="nt-label-sm">Host</label>
											<input
												type="text"
												class="nt-input nt-input-sm"
												bind:value={res.host}
												placeholder={'{{ params.domain }}'}
											/>
										</div>
										<div class="nt-field nt-field-check" style="padding-top: 1.25rem">
											<label class="nt-check-label">
												<input type="checkbox" bind:checked={res.tlsEnabled} />
												TLS Enabled
											</label>
										</div>
									</div>

									<!-- Routes -->
									<div class="nt-sub-section">
										<div class="nt-sub-header">
											<span class="nt-label-sm">Routes</span>
											<button class="nt-add-btn-sm" onclick={() => addRoute(ri)}>
												<Plus class="h-3 w-3" /> Add
											</button>
										</div>
										{#each res.routes as route, roi}
											<div class="nt-route-row">
												<input
													type="text"
													class="nt-input nt-input-sm"
													bind:value={route.path}
													placeholder="/"
													style="max-width: 5rem"
												/>
												<input
													type="text"
													class="nt-input nt-input-sm"
													bind:value={route.serviceName}
													placeholder={'{{ resources.app.serviceName }}'}
												/>
												<input
													type="number"
													class="nt-input nt-input-sm"
													bind:value={route.servicePort}
													placeholder="80"
													style="max-width: 5rem"
												/>
												<button class="nt-remove-btn-sm" onclick={() => removeRoute(ri, roi)}>
													<Trash2 class="h-3 w-3" />
												</button>
											</div>
										{/each}
									</div>

									<div class="nt-res-context">
										<span class="nt-label-sm">Available in context:</span>
										<code>id</code> <code>host</code>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}

				{#if resources.length === 0}
					<div class="nt-empty-inline">No resources yet. Add at least one resource.</div>
				{/if}
			</section>
		</div>
	{/if}

	<!-- Actions -->
	<div class="nt-actions">
		<button class="nt-btn nt-btn-primary" onclick={save} disabled={saving}>
			{#if saving}
				<Loader2 class="h-4 w-4 animate-spin" />
				Creating...
			{:else}
				<LayoutTemplate class="h-4 w-4" />
				Create Template
			{/if}
		</button>
	</div>
</div>

<style>
	.nt-page {
		max-width: 48rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 4rem;
	}

	.nt-back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		margin-bottom: 1.5rem;
		transition: color 0.15s;
	}
	.nt-back:hover {
		color: var(--center-channel-color);
	}

	.nt-header {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		margin-bottom: 2rem;
	}
	.nt-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}
	.nt-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	/* Mode toggle */
	.nt-mode-toggle {
		display: flex;
		gap: 0;
		margin-bottom: 1.5rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		overflow: hidden;
		width: fit-content;
	}
	.nt-mode-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 1rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		transition: all 0.15s;
	}
	.nt-mode-btn:not(:last-child) {
		border-right: 1px solid var(--surface-border);
	}
	.nt-mode-active {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
	}

	.nt-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	/* YAML editor */
	.nt-yaml-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.nt-yaml-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0;
	}
	.nt-link {
		background: none;
		border: none;
		color: var(--sidebar-text-active-border);
		cursor: pointer;
		font-size: inherit;
		padding: 0;
		text-decoration: underline;
	}
	.nt-yaml-editor {
		width: 100%;
		min-height: 500px;
		padding: 1rem;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.6;
		resize: vertical;
		tab-size: 2;
	}
	.nt-yaml-editor:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	/* Visual editor */
	.nt-visual {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.nt-section {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		padding: 1.5rem;
		background-color: var(--surface-bg);
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}
	.nt-section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.nt-section-title {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		margin: 0;
	}
	.nt-section-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: -0.5rem 0 0;
	}
	.nt-section-desc code {
		font-size: 0.75rem;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	/* Fields */
	.nt-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.nt-field-check {
		justify-content: center;
	}
	.nt-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--surface-muted);
	}
	.nt-label-sm {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
	}
	.nt-req {
		color: var(--error-text-color);
	}
	.nt-hint {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.nt-input {
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}
	.nt-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}
	.nt-input-sm {
		padding: 0.375rem 0.625rem;
		font-size: 0.8125rem;
	}
	.nt-input-xs {
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
	}
	.nt-input-mono {
		font-family: var(--font-mono);
	}
	.nt-select {
		cursor: pointer;
	}

	.nt-check-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--center-channel-color);
		cursor: pointer;
	}

	/* Grids */
	.nt-grid-2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	.nt-grid-3 {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 0.75rem;
	}

	/* Param cards */
	.nt-param-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		background-color: var(--center-channel-bg);
	}
	.nt-param-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.nt-param-num {
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--surface-muted);
		min-width: 1.5rem;
	}

	/* Resource cards */
	.nt-res-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		overflow: hidden;
		background-color: var(--center-channel-bg);
	}
	.nt-res-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background-color: color-mix(in srgb, var(--surface-border) 20%, transparent);
	}
	.nt-res-body {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-top: 1px solid var(--surface-border);
	}
	.nt-res-context {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}
	.nt-res-context code {
		font-size: 0.6875rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
	}

	/* Sub-sections */
	.nt-sub-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.nt-sub-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	/* Rows */
	.nt-env-row,
	.nt-port-row,
	.nt-route-row,
	.nt-option-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.nt-env-row > input:first-child {
		max-width: 12rem;
	}

	/* Buttons */
	.nt-add-btn {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.3125rem 0.75rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		border: 1px solid var(--surface-border);
		background: transparent;
		color: var(--center-channel-color);
		cursor: pointer;
		transition: all 0.15s;
	}
	.nt-add-btn:hover {
		border-color: var(--sidebar-text-active-border);
		color: var(--sidebar-text-active-border);
	}

	.nt-add-btn-sm {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.1875rem 0.5rem;
		border-radius: 0.25rem;
		font-size: 0.6875rem;
		border: 1px dashed var(--surface-border);
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		transition: all 0.15s;
	}
	.nt-add-btn-sm:hover {
		border-color: var(--sidebar-text-active-border);
		color: var(--sidebar-text-active-border);
	}

	.nt-remove-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.15s;
	}
	.nt-remove-btn:hover {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.nt-remove-btn-sm {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.25rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
	}
	.nt-remove-btn-sm:hover {
		color: var(--error-text-color);
	}

	.nt-collapse-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
	}

	.nt-empty-inline {
		padding: 1.5rem;
		text-align: center;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		border: 1px dashed var(--surface-border);
		border-radius: 0.75rem;
	}

	/* Options */
	.nt-options {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	/* Actions */
	.nt-actions {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--surface-border);
	}
	.nt-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 1.25rem;
		border-radius: 0.5rem;
		font-size: 0.875rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
	}
	.nt-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.nt-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.08),
			0 1px 1px rgb(0 0 0 / 0.04);
	}
	.nt-btn-primary:hover:not(:disabled) {
		opacity: 0.95;
		transform: translateY(-0.5px);
		box-shadow:
			0 2px 4px rgb(0 0 0 / 0.08),
			0 4px 12px rgb(0 0 0 / 0.06);
	}
</style>
