<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree, fetchProjectContext, buildBasePath, type ProjectContext } from '$lib/stores';
	import { Loader2, FileText, Upload } from 'lucide-svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';

	const EXAMPLE_COMPOSE = `services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
  cache:
    image: redis:7
    ports:
      - "6379"
`;

	let project = $state<ProjectContext | null>(null);
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let formError = $state<string | null>(null);

	let name = $state('');
	let composeYaml = $state(EXAMPLE_COMPOSE);
	let fileInput = $state<HTMLInputElement | null>(null);

	const projectSlug = $derived($page.params.projectSlug ?? '');
	const orgSlug = $derived($page.params.orgSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const basePath = $derived(buildBasePath({ orgSlug, projectSlug, wsSlug }));

	async function fetchProjectData() {
		loading = true;
		error = null;
		try {
			project = await fetchProjectContext({ orgSlug, projectSlug, wsSlug });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load project';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchProjectData();
	});

	function handleFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			composeYaml = String(reader.result || '');
		};
		reader.readAsText(file);
	}

	async function handleSubmit() {
		formError = null;
		if (!project?.id) {
			formError = 'Project not loaded';
			return;
		}
		if (!name.trim()) {
			formError = 'Stack name is required';
			return;
		}
		if (!composeYaml.trim()) {
			formError = 'Compose file is required';
			return;
		}

		submitting = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/compose-stacks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), composeYaml }),
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create compose stack');
			}

			const stack = await response.json();
			toasts.add({
				title: 'Compose stack created',
				description: 'Services are being deployed',
				color: 'success',
			});
			refreshTree();
			goto(`/${orgSlug}/compose-stacks/${stack.id}`);
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Failed to create compose stack';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="cs-page">
	{#if loading}
		<div class="cs-loader"><Loader2 class="h-5 w-5 animate-spin" /> Loading project…</div>
	{:else if error}
		<div class="cs-warning">
			<p class="cs-warning-title">Could not load project</p>
			<p class="cs-warning-desc">{error}</p>
		</div>
	{:else if project}
		<div class="cs-hero">
			<h1 class="cs-page-title">New Compose Stack</h1>
			<p class="cs-page-subtitle">Deploy multiple services from a single docker-compose.yml file.</p>
		</div>

		<div class="cs-main-card">
			<div class="cs-source-row">
				<span class="cs-source-label"><FileText class="h-3.5 w-3.5" /> Compose stack</span>
			</div>

			<div class="cs-owner-row">
				<ProjectSwitcher
					currentProjectName={project?.name || projectSlug}
					pathSuffix={`/compose-stacks/new`}
				/>
				<span class="cs-slash">/</span>
				<input type="text" bind:value={name} placeholder="my-stack" class="cs-name-input" />
			</div>

			<div class="cs-card-body">
				<div class="cs-field">
					<div class="cs-label-row">
						<label class="cs-label" for="compose-yaml">docker-compose.yml</label>
						<button type="button" class="cs-btn cs-btn-secondary cs-btn-sm" onclick={() => fileInput?.click()}>
							<Upload class="h-3.5 w-3.5" /> Upload file
						</button>
						<input
							type="file"
							accept=".yml,.yaml"
							bind:this={fileInput}
							style="display: none;"
							onchange={handleFile}
						/>
					</div>
					<textarea
						id="compose-yaml"
						bind:value={composeYaml}
						class="cs-textarea cs-mono"
						spellcheck="false"
						rows="20"
					></textarea>
					<p class="cs-hint">
						Supported: <code>image</code>, <code>ports</code>, <code>environment</code>, <code>volumes</code> (named),
						<code>command</code>, <code>depends_on</code>. <code>build:</code> is not supported — use a pre-built image
						or the GitHub deploy flow.
					</p>
				</div>

				{#if formError}
					<div class="cs-warning">
						<p class="cs-warning-desc">{formError}</p>
					</div>
				{/if}

				<div class="cs-actions">
					<button type="button" class="cs-btn cs-btn-secondary" onclick={() => history.back()} disabled={submitting}>
						Cancel
					</button>
					<button
						type="button"
						class="cs-btn cs-btn-primary"
						onclick={handleSubmit}
						disabled={submitting}
					>
						{#if submitting}
							<Loader2 class="h-3.5 w-3.5 animate-spin" /> Deploying…
						{:else}
							Deploy stack
						{/if}
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.cs-page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1.5rem 2.5rem 3rem;
	}

	.cs-hero {
		padding: 2rem 0 1.75rem;
	}

	.cs-page-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.025em;
		background: linear-gradient(135deg, var(--sidebar-text-active-border), color-mix(in srgb, var(--sidebar-text-active-border) 60%, #0db7ed));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.cs-page-subtitle {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	.cs-main-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		display: flex;
		flex-direction: column;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.04), 0 1px 2px rgb(0 0 0 / 0.02);
	}

	.cs-source-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.875rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.cs-source-label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.cs-owner-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1.25rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.cs-slash {
		font-size: 1.25rem;
		font-weight: 300;
		color: var(--surface-muted);
		user-select: none;
	}

	.cs-name-input {
		flex: 1;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		transition: border-color 0.15s;
	}

	.cs-name-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}

	.cs-card-body {
		padding: 1.25rem 1.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.cs-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.cs-label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.cs-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.cs-textarea {
		width: 100%;
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		line-height: 1.5;
		min-height: 18rem;
		resize: vertical;
	}

	.cs-mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
	}

	.cs-textarea:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}

	.cs-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
		line-height: 1.5;
	}

	.cs-hint code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
		padding: 0.0625rem 0.25rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
		font-size: 0.6875rem;
	}

	.cs-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.cs-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
		transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
	}

	.cs-btn-sm {
		padding: 0.25rem 0.5rem;
		font-size: 0.6875rem;
	}

	.cs-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.cs-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: white;
	}

	.cs-btn-primary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 85%, black);
	}

	.cs-btn-secondary {
		border-color: var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
	}

	.cs-btn-secondary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}

	.cs-warning {
		padding: 0.75rem 0.875rem;
		border-radius: 0.5rem;
		border: 1px solid color-mix(in srgb, #ef4444 30%, var(--surface-border));
		background-color: color-mix(in srgb, #ef4444 5%, var(--surface-bg));
	}

	.cs-warning-title {
		font-size: 0.8125rem;
		font-weight: 600;
		margin: 0 0 0.25rem;
		color: var(--center-channel-color);
	}

	.cs-warning-desc {
		font-size: 0.75rem;
		margin: 0;
		color: var(--surface-muted);
	}

	.cs-loader {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 4rem 0;
		justify-content: center;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}
</style>
