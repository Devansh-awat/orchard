<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { selectedOrganization, apiFetch, toasts, refreshTree } from '$lib/stores';
	import { Loader2, Building2, FolderKanban } from 'lucide-svelte';

	const orgSlug = $derived($page.params.orgSlug);

	let name = $state('');
	let slug = $state('');
	let description = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let autoSlug = $state(true);

	const selectedOrgId = $derived($selectedOrganization?.id ?? '');
	const selectedOrgName = $derived($selectedOrganization?.name ?? '');

	// Auto-generate slug from name
	$effect(() => {
		if (autoSlug && name) {
			slug = name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
		}
	});

	function handleSlugInput() {
		autoSlug = false;
	}

	async function submit() {
		if (!name.trim()) {
			error = 'Workspace name is required';
			return;
		}

		if (!slug.trim()) {
			error = 'Workspace slug is required';
			return;
		}

		if (!selectedOrgId) {
			error = 'Please select an organization';
			return;
		}

		submitting = true;
		error = null;

		try {
			const response = await apiFetch('/apiv1/workspaces', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					name: name.trim(),
					slug: slug.trim(),
					description: description.trim() || undefined,
					organizationId: selectedOrgId
				})
			});

			const data = await response.json().catch(() => ({}));

			if (!response.ok) {
				throw new Error(data.message || 'Failed to create workspace');
			}

			const workspace = data;

			toasts.add({
				title: 'Workspace created',
				description: `${workspace.name} has been created successfully`,
				color: 'success'
			});

			refreshTree();
			goto(`/${orgSlug}/workspaces/${workspace.slug}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create workspace';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="nw-page">
	<!-- Header -->
	<div class="nw-header">
		<div class="nw-header-icon">
			<FolderKanban class="h-6 w-6" />
		</div>
		<div>
			<h1 class="nw-title">New Workspace</h1>
			<p class="nw-subtitle">Organize your projects and deployments.</p>
		</div>
	</div>

	<!-- Card -->
	<div class="nw-card">
		{#if error}
			<div class="nw-error">{error}</div>
		{/if}

		<div class="nw-form">
			<!-- Organization -->
			<div class="nw-field">
				<span class="nw-label">Organization</span>
				<div class="nw-org-display">
					<Building2 class="h-4 w-4 shrink-0" />
					<span>{selectedOrgName || 'No organization selected'}</span>
				</div>
			</div>

			<!-- Name -->
			<div class="nw-field">
				<label for="name" class="nw-label">Name</label>
				<input
					id="name"
					type="text"
					bind:value={name}
					placeholder="My Workspace"
					class="nw-input"
				/>
			</div>

			<!-- Slug -->
			<div class="nw-field">
				<label for="slug" class="nw-label">Slug</label>
				<input
					id="slug"
					type="text"
					bind:value={slug}
					oninput={handleSlugInput}
					placeholder="my-workspace"
					class="nw-input nw-input-mono"
				/>
				<p class="nw-hint">Used in URLs and namespace generation</p>
			</div>

			<!-- Namespace preview -->
			{#if $selectedOrganization && slug}
				<div class="nw-preview">
					<span class="nw-preview-label">Namespace</span>
					<code class="nw-preview-value">{$selectedOrganization.slug}-{slug}</code>
				</div>
			{/if}

			<!-- Description -->
			<div class="nw-field">
				<label for="description" class="nw-label">
					Description
					<span class="nw-optional">optional</span>
				</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder="A brief description of this workspace"
					rows="2"
					class="nw-input"
				></textarea>
			</div>
		</div>

		<!-- Actions -->
		<div class="nw-actions">
			<button class="nw-btn nw-btn-secondary" onclick={() => window.history.back()}>
				Cancel
			</button>
			<button class="nw-btn nw-btn-primary" onclick={submit} disabled={submitting}>
				{#if submitting}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				Create Workspace
			</button>
		</div>
	</div>
</div>

<style>
	.nw-page {
		max-width: 32rem;
		margin: 0 auto;
		padding: 2rem;
		min-height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
	}

	/* Header */
	.nw-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 2rem;
	}

	.nw-header-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 0.875rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
		flex-shrink: 0;
	}

	.nw-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}

	.nw-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
		line-height: 1.4;
	}

	/* Card */
	.nw-card {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		padding: 1.75rem;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	/* Error */
	.nw-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1rem;
	}

	/* Form */
	.nw-form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	/* Field — clear spacing between label/input groups */
	.nw-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		position: relative;
	}

	.nw-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--surface-muted);
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.nw-optional {
		font-size: 0.6875rem;
		font-weight: 400;
		color: color-mix(in srgb, var(--surface-muted) 60%, transparent);
	}

	.nw-hint {
		font-size: 0.75rem;
		color: color-mix(in srgb, var(--surface-muted) 75%, transparent);
		margin: 0;
		line-height: 1.4;
	}

	/* Input */
	.nw-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.15s;
		resize: none;
	}

	.nw-input::placeholder {
		color: var(--surface-muted);
	}

	.nw-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	.nw-input-mono {
		font-family: var(--font-mono);
	}

	/* Org display */
	.nw-org-display {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}

	/* Preview */
	.nw-preview {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}

	.nw-preview-label {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		white-space: nowrap;
	}

	.nw-preview-value {
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--sidebar-text-active-border);
	}

	/* Actions */
	.nw-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.625rem;
		margin-top: 1.75rem;
		padding-top: 1.5rem;
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
	}

	/* Buttons — primary/secondary hierarchy */
	.nw-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition: all 0.2s ease;
		white-space: nowrap;
	}

	.nw-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.nw-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.08),
			0 1px 1px rgb(0 0 0 / 0.04);
	}

	.nw-btn-primary:hover:not(:disabled) {
		opacity: 0.95;
		transform: translateY(-0.5px);
		box-shadow:
			0 2px 4px rgb(0 0 0 / 0.08),
			0 4px 12px rgb(0 0 0 / 0.06);
	}

	.nw-btn-secondary {
		background-color: transparent;
		color: var(--surface-muted);
		border: 1px solid var(--surface-border);
	}

	.nw-btn-secondary:hover:not(:disabled) {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}
</style>
