<script lang="ts">
	import { toasts } from '$lib/stores';
	import { fly, fade } from '$lib/utils/transitions';
	import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-svelte';

	const iconMap = {
		success: CheckCircle2,
		error: AlertCircle,
		warning: AlertTriangle,
		info: Info
	};
</script>

<div class="toast-stack">
	{#each $toasts as toast (toast.id)}
		<div
			class="toast toast-{toast.color}"
			role="alert"
			in:fly={{ x: 24, duration: 200 }}
			out:fade={{ duration: 150 }}
		>
			<div class="toast-icon">
				<svelte:component this={iconMap[toast.color]} size={16} />
			</div>
			<div class="toast-body">
				<p class="toast-title">{toast.title}</p>
				{#if toast.description}
					<p class="toast-desc">{toast.description}</p>
				{/if}
			</div>
			<button
				class="toast-close"
				onclick={() => toasts.remove(toast.id)}
				aria-label="Dismiss notification"
			>
				<X size={14} />
			</button>
		</div>
	{/each}
</div>

<style>
	.toast-stack {
		position: fixed;
		bottom: 1rem;
		right: 1rem;
		z-index: 1000;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		pointer-events: none;
		max-width: calc(100vw - 2rem);
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 18rem;
		max-width: 22rem;
		padding: 0.75rem 0.875rem;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		box-shadow:
			0 10px 30px rgba(0, 0, 0, 0.12),
			0 2px 6px rgba(0, 0, 0, 0.06);
		color: var(--center-channel-color);
	}

	:global(.dark) .toast {
		box-shadow:
			0 10px 30px rgba(0, 0, 0, 0.4),
			0 2px 6px rgba(0, 0, 0, 0.25);
	}

	.toast-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
	}

	.toast-success .toast-icon {
		background-color: color-mix(in srgb, var(--success-text) 14%, transparent);
		color: var(--success-text);
	}

	:global(.dark) .toast-success .toast-icon {
		background-color: color-mix(in srgb, var(--success-muted) 18%, transparent);
		color: var(--success-muted);
	}

	.toast-error .toast-icon {
		background-color: color-mix(in srgb, var(--error-text-color) 14%, transparent);
		color: var(--error-text-color);
	}

	.toast-warning .toast-icon {
		background-color: color-mix(in srgb, #f59e0b 16%, transparent);
		color: #d97706;
	}

	:global(.dark) .toast-warning .toast-icon {
		color: #f59e0b;
	}

	.toast-info .toast-icon {
		background-color: color-mix(in srgb, var(--info-text) 14%, transparent);
		color: var(--info-text);
	}

	.toast-body {
		flex: 1;
		min-width: 0;
	}

	.toast-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.toast-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.1875rem 0 0;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.toast-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition:
			color 0.15s,
			background-color 0.15s;
	}

	.toast-close:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
	}
</style>
