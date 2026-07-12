<script lang="ts">
	import { onMount } from 'svelte';
	import { KeyRound, Lock } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { envBadgeColor } from '$lib/utils/format';
	import { Button, Alert } from '$lib/components/ui';
	import EnvVarGrid, { type GridRow } from './EnvVarGrid.svelte';
	import type { SharedVarWarning } from '$lib/types/environments';

	let {
		environmentId,
		envName = '',
		envSlug = ''
	}: {
		environmentId: string;
		envName?: string;
		envSlug?: string;
	} = $props();

	let rows = $state<GridRow[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let warnings = $state<SharedVarWarning[]>([]);

	async function load() {
		loading = true;
		try {
			const res = await apiFetch(`/apiv1/environments/${environmentId}/shared-vars`);
			if (res.ok) {
				const data = await res.json();
				rows = data.map((v: any) => ({ key: v.key, value: v.value ?? '', secret: v.secret }));
			}
		} finally {
			loading = false;
		}
	}

	async function save() {
		saving = true;
		warnings = [];
		try {
			const vars = rows.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value, secret: r.secret }));
			const res = await apiFetch(`/apiv1/environments/${environmentId}/shared-vars`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ vars })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to save');
			}
			const result = await res.json();
			warnings = result.warnings ?? [];
			toasts.add({ title: 'Shared variables saved', color: 'success' });
			await load();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to save', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

<div class="sharedvars" style="--env-c: {envBadgeColor(envSlug)}">
	<div class="sharedvars-head">
		<h3 class="sharedvars-title">
			<span class="sharedvars-dot"></span>
			{envName || 'Environment'}
			<span class="sharedvars-title-sub">shared variables</span>
		</h3>
		<Button variant="primary" size="sm" loading={saving} onclick={save}>Save</Button>
	</div>

	{#if loading}
		<div class="sharedvars-skeleton"></div>
	{:else if rows.length === 0}
		<button type="button" class="sharedvars-empty" onclick={() => (rows = [{ key: '', value: '', secret: false }])}>
			<span class="sharedvars-empty-icon"><KeyRound size={20} /></span>
			<span class="sharedvars-empty-title">Add a shared variable</span>
		</button>
	{:else}
		<EnvVarGrid bind:rows />
	{/if}

	{#if !loading && rows.some((r) => r.secret)}
		<p class="sharedvars-secret-note">
			<Lock size={12} />
			<span>
				Secret values are write-only — they're encrypted at rest and never shown again. Enter a new
				value to replace one.
			</span>
		</p>
	{/if}

	{#if warnings.length > 0}
		<Alert tone="warning">
			Unresolved: {warnings.map((w) => `\${{shared.${w.missingRef}}}`).join(', ')}
		</Alert>
	{/if}
</div>

<style>
	.sharedvars {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.sharedvars-secret-note {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--surface-muted);
	}
	.sharedvars-secret-note :global(svg) {
		flex-shrink: 0;
		margin-top: 0.1rem;
	}
	.sharedvars-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}
	.sharedvars-title {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.95rem;
		font-weight: 650;
		color: var(--center-channel-color);
		letter-spacing: -0.01em;
	}
	.sharedvars-title-sub {
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--surface-muted);
	}
	.sharedvars-dot {
		width: 9px;
		height: 9px;
		border-radius: 9999px;
		background: var(--env-c);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--env-c) 18%, transparent);
		align-self: center;
	}
	.sharedvars-skeleton {
		height: 5rem;
		border-radius: 0.75rem;
		background: linear-gradient(
			100deg,
			var(--control-bg) 30%,
			color-mix(in srgb, var(--surface-muted) 8%, var(--control-bg)) 50%,
			var(--control-bg) 70%
		);
		background-size: 200% 100%;
		animation: sv-shimmer 1.3s ease-in-out infinite;
	}
	@keyframes sv-shimmer {
		from {
			background-position: 200% 0;
		}
		to {
			background-position: -200% 0;
		}
	}
	.sharedvars-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		padding: 2.25rem 1.5rem;
		border: 1px dashed var(--surface-border);
		border-radius: 0.85rem;
		text-align: center;
		transition:
			border-color 140ms ease,
			background-color 140ms ease;
	}
	.sharedvars-empty:hover {
		border-color: color-mix(in srgb, var(--env-c) 40%, var(--surface-border));
		background: color-mix(in srgb, var(--env-c) 4%, transparent);
	}
	.sharedvars-empty-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.7rem;
		background: color-mix(in srgb, var(--env-c) 12%, var(--control-bg));
		color: var(--env-c);
		margin-bottom: 0.2rem;
	}
	.sharedvars-empty-title {
		font-size: 0.85rem;
		font-weight: 550;
		color: var(--surface-muted);
	}
</style>
